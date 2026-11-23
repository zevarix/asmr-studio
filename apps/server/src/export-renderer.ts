import {constants} from 'node:fs';
import {chmod,lstat,mkdtemp,open,rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';
import {parseScene,parseAssetRecord,scenePlaybackAssetIds,listeningDuration,listeningFadeError,EXPORT_SAMPLE_RATE,MAX_EXPORT_SECONDS,type Scene,type Layer,type AssetRecord,type ExportResult,type EqualizerSettings} from '@asmr-studio/contracts';
import {createOccasionalSchedule,prepareLoop,loopExtraBytes,equalizerCoefficients,movementParameters,type LoopAudioBuffer} from '@asmr-studio/audio-engine';
import {StudioError} from './errors.js';
import {OUTPUT_STREAM_BUFFER_BYTES,writeProcessedWav} from './output-wav.js';
import {TRANSITION_OUTPUT_STREAM_BUFFER_BYTES,writeTransitionWav} from './transition-output-wav.js';

const rate=EXPORT_SAMPLE_RATE;
const blockBytes=65536;
const maximumFrames=Math.round(MAX_EXPORT_SECONDS*rate);
interface RenderOptions {
  scene:Scene;
  assets:Array<{record:AssetRecord;path:string}>;
  workDirectory:string;
  outputPath:string;
  durationSeconds:number;
  signal:AbortSignal;
  onProgress:(progress:number)=>void;
  decodedBudgetBytes?:number;
  /** A lower job-local cap is useful for constrained hosts; it cannot raise the hard limit. */
  occasionalSpoolBudgetBytes?:number;
}
interface Pcm extends LoopAudioBuffer {duration:number}
interface PreparedInput {path:string;channels:number;frames:number;introFrames:number;looping:boolean}
const budgetError=()=>new StudioError('EXPORT_BUDGET_EXCEEDED','This mix exceeds the export memory budget. Try shorter loops or fewer layers.',422);

function checkAbort(signal:AbortSignal):void {
  if(signal.aborted){const error=new Error('Export canceled');error.name='AbortError';throw error;}
}
function pcm(channels:number,length:number,sampleRate:number):Pcm {
  const data=Array.from({length:channels},()=>new Float32Array(length));
  return {numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,getChannelData(channel){return data[channel]!;}};
}
async function regularFile(path:string):Promise<FileHandle>{
  if(!isAbsolute(path))throw new Error('Export files require internal absolute paths');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{if(!(await file.stat()).isFile())throw new Error('Export input must be a regular file');return file;}
  catch(error){await file.close();throw error;}
}
async function verifySource(path:string,expected:string,signal:AbortSignal):Promise<void>{
  const file=await regularFile(path);
  try{
    const hash=createHash('sha256');
    for await(const chunk of file.createReadStream({autoClose:false})){checkAbort(signal);hash.update(chunk);}
    if(hash.digest('hex')!==expected)throw new Error('Export source integrity check failed');
  }finally{await file.close();}
}

/** Every child is owned here; cancellation and consumer failure both kill and reap it. */
async function ffmpeg(args:string[],signal:AbortSignal,onData?:(data:Buffer)=>Promise<void>,onTime?:(seconds:number)=>void):Promise<void>{
  checkAbort(signal);
  const child=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-filter_threads','1','-filter_complex_threads','1',...args],{stdio:['ignore','pipe','pipe','pipe'],windowsHide:true});
  let closed=false;
  const finished=new Promise<void>((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',code=>{closed=true;code===0?resolve():reject(new Error('FFmpeg could not complete the export'));});
  });
  const kill=()=>{if(!closed)child.kill('SIGKILL');};
  signal.addEventListener('abort',kill,{once:true});
  const consumers=[
    (async()=>{for await(const part of child.stdout!){checkAbort(signal);if(onData)await onData(Buffer.from(part));}})(),
    (async()=>{for await(const _part of child.stderr!){/* Drain diagnostics without retaining paths or unbounded text. */}})(),
    (async()=>{
      let partial='';
      for await(const part of child.stdio[3] as Readable){
        partial+=String(part);const lines=partial.split('\n');partial=lines.pop()??'';
        if(partial.length>4096)throw new Error('Invalid FFmpeg progress');
        for(const line of lines)if(line.startsWith('out_time_us=')){
          const time=Number(line.slice(12))/1_000_000;if(Number.isFinite(time))onTime?.(time);
        }
      }
    })(),
  ];
  try{await Promise.all([finished,...consumers]);checkAbort(signal);}
  catch(error){kill();await Promise.allSettled([finished,...consumers]);checkAbort(signal);throw error;}
  finally{signal.removeEventListener('abort',kill);}
}

async function decode(source:string,destination:string,channels:number,availableBytes:number,signal:AbortSignal):Promise<Pcm>{
  const output=await open(destination,'wx',0o600);let bytes=0;
  try{
    await ffmpeg(['-protocol_whitelist','file,pipe','-format_whitelist','wav,flac,mp3,ogg,mov','-threads','1','-i',source,
      '-map','0:a:0','-vn','-sn','-dn','-ar',String(rate),'-ac',String(channels),'-c:a','pcm_f32le','-threads','1','-f','f32le','pipe:1'],signal,async part=>{
      bytes+=part.length;if(bytes>availableBytes)throw budgetError();
      await output.writeFile(part);
    });
  }finally{await output.close();}
  if(bytes===0||bytes%(channels*4)!==0)throw new Error('Invalid decoded export audio');
  const result=pcm(channels,bytes/(channels*4),rate);const file=await regularFile(destination);
  const block=Buffer.allocUnsafe(blockBytes);let position=0;
  try{
    while(position<bytes){
      checkAbort(signal);const read=await file.read(block,0,Math.min(block.length,bytes-position),position);
      if(!read.bytesRead||read.bytesRead%(channels*4)!==0)throw new Error('Incomplete decoded export audio');
      for(let offset=0;offset<read.bytesRead;offset+=4){
        const value=block.readFloatLE(offset);if(!Number.isFinite(value))throw new Error('Non-finite decoded export audio');
        const sample=(position+offset)/4;result.getChannelData(sample%channels)[Math.floor(sample/channels)]=value;
      }
      position+=read.bytesRead;
    }
  }finally{await file.close();}
  return result;
}
async function writeLoop(path:string,input:Pcm,prepared:ReturnType<typeof prepareLoop<Pcm>>,signal:AbortSignal):Promise<void>{
  const intro=Math.round(prepared.introSeconds*rate);const period=Math.round(prepared.periodSeconds*rate);
  const originalStart=Math.round(prepared.originalStartSeconds*rate);const repeatedStart=Math.round(prepared.offsetBaseSeconds*rate);
  const file=await open(path,'wx',0o600);const block=Buffer.allocUnsafe(blockBytes);
  const framesPerBlock=blockBytes/(input.numberOfChannels*4);
  try{
    for(let start=0;start<intro+period;start+=framesPerBlock){
      checkAbort(signal);const frames=Math.min(framesPerBlock,intro+period-start);
      for(let frame=0;frame<frames;frame++)for(let channel=0;channel<input.numberOfChannels;channel++){
        const at=start+frame;
        const value=at<intro?input.getChannelData(channel)[originalStart+at]!:prepared.buffer.getChannelData(channel)[repeatedStart+at-intro]!;
        block.writeFloatLE(value,(frame*input.numberOfChannels+channel)*4);
      }
      await file.writeFile(block.subarray(0,frames*input.numberOfChannels*4));
    }
  }finally{await file.close();}
}
/** Positional writes represent pauses. Charge logical size, since sparse allocation is filesystem-dependent. */
async function writeOccasional(path:string,layer:Layer,inputs:ReadonlyMap<string,{buffer:Pcm}>,
  durations:ReadonlyMap<string,number>,endpoint:number,availableBytes:number,signal:AbortSignal,onProgress:(fraction:number)=>void,envelopeEndpoint=endpoint):Promise<{frames:number;bytes:number}>{
  const file=await open(path,'wx',0o600);
  const start=Math.round(layer.startSeconds*rate);
  const block=Buffer.allocUnsafe(blockBytes);
  let frames=0,bytes=0;
  try{
    for(const event of createOccasionalSchedule(layer,durations).events(start/rate,endpoint/rate)){
      checkAbort(signal);
      const source=inputs.get(event.assetId)!.buffer;
      const envelopeLength=Math.min(source.length,event.endFrame-event.startFrame,envelopeEndpoint-event.startFrame);
      const length=Math.min(envelopeLength,endpoint-event.startFrame);
      if(length<=0)continue;
      const offset=event.startFrame-start;
      // Include silent holes in the allowance: NTFS need not allocate them sparsely.
      bytes=(offset+length)*8;
      if(bytes>availableBytes)throw new StudioError('EXPORT_STORAGE_BUDGET','Occasional audio exceeds the temporary export storage limit. Shorten the export or use fewer occasional layers.',422);
      const left=source.getChannelData(0),right=source.numberOfChannels===2?source.getChannelData(1):null;
      const pan=Math.fround(event.pan);
      const angle=right?(pan<=0?pan+1:pan)*Math.PI/2:(pan+1)*Math.PI/4;
      const cos=Math.cos(angle),sin=Math.sin(angle),fade=Math.min(.02*rate,envelopeLength/2);
      for(let at=0;at<length;){
        checkAbort(signal);
        const count=Math.min(blockBytes/8,length-at);
        for(let frame=0;frame<count;frame++){
          const sample=at+frame,level=event.gain*Math.min(1,sample/fade,(envelopeLength-sample)/fade);
          const l=left[sample]!;const r=right?.[sample]??0;
          const pannedLeft=right?(pan<=0?l+r*cos:l*cos):l*cos;
          const pannedRight=right?(pan<=0?r*sin:r+l*sin):l*sin;
          block.writeFloatLE(pannedLeft*level,frame*8);
          block.writeFloatLE(pannedRight*level,frame*8+4);
        }
        let written=0;
        while(written<count*8){
          checkAbort(signal);
          const result=await file.write(block,written,count*8-written,(offset+at)*8+written);
          if(!result.bytesWritten)throw new Error('Incomplete occasional export input');
          written+=result.bytesWritten;
        }
        at+=count;onProgress((offset+at)/(endpoint-start));
      }
      frames=offset+length;
    }
  }finally{await file.close();}
  return {frames,bytes};
}
function coefficient(value:number):string{return String(Math.abs(value)<1e-15?0:value);}
function panFilter(channels:number,pan:number):string{
  if(channels===1){const angle=(pan+1)*Math.PI/4;return `pan=stereo|c0=${coefficient(Math.cos(angle))}*c0|c1=${coefficient(Math.sin(angle))}*c0`;}
  if(pan<=0){const angle=(pan+1)*Math.PI/2;return `pan=stereo|c0=c0+${coefficient(Math.cos(angle))}*c1|c1=${coefficient(Math.sin(angle))}*c1`;}
  const angle=pan*Math.PI/2;return `pan=stereo|c0=${coefficient(Math.cos(angle))}*c0|c1=c1+${coefficient(Math.sin(angle))}*c0`;
}
function movingPanFilter(channels:number,parameters:ReturnType<typeof movementParameters>):string{
  const {center,radius,frequency}=parameters;
  // n starts at the layer's first sample, downstream of all loop repetitions and before
  // its saved start delay. Shared Float32 parameters match the browser's AudioParams.
  const position=`st(0,clip(${center}+${radius}*sin(2*PI*${frequency}*n/${rate}),-1,1));`;
  const left=channels===1
    ? 'val(0)*cos((ld(0)+1)*PI/4)'
    : 'if(lte(ld(0),0),val(0)+val(1)*cos((ld(0)+1)*PI/2),val(0)*cos(ld(0)*PI/2))';
  const right=channels===1
    ? 'val(0)*sin((ld(0)+1)*PI/4)'
    : 'if(lte(ld(0),0),val(1)*sin((ld(0)+1)*PI/2),val(1)+val(0)*sin(ld(0)*PI/2))';
  // aeval emits an unspecified two-channel layout even with c=stereo. Restore named
  // stereo channels as well as Float32, or downstream biquads silently bypass them.
  return `aeval=exprs='${position}${left}|${position}${right}':c=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo`;
}
function envelope(frames:number,channels:number,horizon=frames):string{
  const fade=Math.min(0.02*rate,frames/2);
  const release=frames-fade<=horizon;
  if(Number.isInteger(fade))return `afade=t=in:ss=0:ns=${fade}:curve=tri`+(release?`,afade=t=out:ss=${frames-fade}:ns=${fade}:curve=tri`:'');
  // Odd, sub-40ms clips have a half-sample midpoint; integer afade lengths cannot represent it.
  return `aeval=exprs='${Array.from({length:channels},(_,channel)=>`val(${channel})*${release?`min(1,min(n/${fade},(${frames}-n)/${fade}))`:`min(1,n/${fade})`}`).join('|')}'`;
}
function equalizer(settings:EqualizerSettings|undefined):{filter:string;bands:number}{
  const bands=equalizerCoefficients(settings,rate);
  if(bands.length===0)return {filter:'',bands:0};
  // Keep stable double-precision filter state, with float32 boundaries like Web Audio nodes.
  // DC normalization would change shelf gain; reverse-IIR block processing would add delay.
  const filters=bands.map(value=>{
    if(Object.values(value).some(number=>!Number.isFinite(number))||value.a0===0)throw new Error('Invalid equalizer coefficients');
    return `biquad=a0=${value.a0}:a1=${value.a1}:a2=${value.a2}:b0=${value.b0}:b1=${value.b1}:b2=${value.b2}:normalize=0:transform=di:precision=f64:blocksize=0,aformat=sample_fmts=fltp`;
  });
  return {filter:'aformat=sample_fmts=fltp,'+filters.join(','),bands:bands.length};
}

async function validateOutput(path:string,frames:number,signal:AbortSignal,progress:(value:number)=>void):Promise<ExportResult>{
  const file=await regularFile(path);
  try{
    const stat=await file.stat();const header=Buffer.alloc(12);await file.read(header,0,12,0);
    if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE'||header.readUInt32LE(4)+8!==stat.size)throw new Error('Invalid exported WAV container');
    let dataOffset=-1;let dataBytes=0;let format=false;
    for(let at=12;at+8<=stat.size;){
      checkAbort(signal);const chunk=Buffer.alloc(8);await file.read(chunk,0,8,at);const size=chunk.readUInt32LE(4);const id=chunk.toString('ascii',0,4);
      if(at+8+size>stat.size)throw new Error('Incomplete exported WAV chunk');
      if(id==='fmt '){
        if(format||size<16)throw new Error('Invalid exported WAV format');const fmt=Buffer.alloc(16);await file.read(fmt,0,16,at+8);
        if(fmt.readUInt16LE(0)!==1||fmt.readUInt16LE(2)!==2||fmt.readUInt32LE(4)!==rate||fmt.readUInt32LE(8)!==rate*4||fmt.readUInt16LE(12)!==4||fmt.readUInt16LE(14)!==16)throw new Error('Export is not 48 kHz stereo PCM16');
        format=true;
      }
      if(id==='data'){if(dataOffset!==-1)throw new Error('Duplicate exported audio data');dataOffset=at+8;dataBytes=size;}
      at+=8+size+(size%2);
    }
    if(!format||dataOffset<0||dataBytes!==frames*4||dataOffset%2!==0)throw new Error('Exported audio has an incorrect frame count');
    const hash=createHash('sha256');const block=Buffer.allocUnsafe(blockBytes);let position=0;let sum=0;let peak=0;let clippedSamples=0;let samples=0;
    while(position<stat.size){
      checkAbort(signal);const read=await file.read(block,0,Math.min(block.length,stat.size-position),position);
      if(read.bytesRead===0)throw new Error('Incomplete exported WAV');hash.update(block.subarray(0,read.bytesRead));
      const start=Math.max(position,dataOffset);const end=Math.min(position+read.bytesRead,dataOffset+dataBytes);
      for(let at=start;at<end;at+=2){
        const integer=block.readInt16LE(at-position);const value=integer/32768;
        peak=Math.max(peak,Math.abs(value));sum+=value*value;samples++;
        if(integer===32767||integer===-32768)clippedSamples++;
      }
      position+=read.bytesRead;progress(0.85+0.15*position/stat.size);
    }
    if(samples!==frames*2)throw new Error('Incomplete exported audio samples');
    checkAbort(signal);
    return {bytes:stat.size,sha256:hash.digest('hex'),durationSeconds:frames/rate,sampleRate:48000,channels:2,peak,rms:Math.sqrt(sum/samples),clippedSamples};
  }finally{await file.close();}
}

/** Renders only fixed scene data and internal snapshot paths; caller owns the final artifact lifecycle. */
export async function renderWav(options:RenderOptions):Promise<ExportResult>{
  const {signal}=options;checkAbort(signal);
  const scene=parseScene(options.scene);const frames=Math.round(options.durationSeconds*rate);
  if(!Number.isFinite(options.durationSeconds)||options.durationSeconds<=0||!Number.isSafeInteger(frames)||frames<1||frames>maximumFrames)throw new Error('A finite WAV export duration is required');
  const transition=scene.transition;
  if(transition&&(!transition.a||!transition.b))throw new Error('A transition export requires both captured mixes');
  const sides=transition?[transition.a!.scene,transition.b!.scene]:[scene];
  const sideEndSeconds=sides.map(side=>transition?(listeningDuration(side.listeningTimer,side.durationSeconds)??Infinity):Infinity);
  const sideEnds=sideEndSeconds.map(deadline=>Math.max(1,Math.round(deadline*rate)));
  const sideFrames=sideEnds.map(endpoint=>Math.min(frames,endpoint));
  const fadeError=listeningFadeError(scene.listeningTimer,frames/rate);
  if(fadeError)throw new StudioError('EXPORT_FADE_INVALID',fadeError,422);
  const fading=scene.listeningTimer?.enabled&&(scene.listeningTimer.fadeInSeconds>0||scene.listeningTimer.fadeOutSeconds>0);
  const processed=scene.outputLimiter?.enabled||fading;
  const budget=options.decodedBudgetBytes??256*1024*1024;
  if(!Number.isSafeInteger(budget)||budget<=0)throw new Error('A positive export audio budget is required');
  const spoolBudget=options.occasionalSpoolBudgetBytes??maximumFrames*8;
  if(!Number.isSafeInteger(spoolBudget)||spoolBudget<=0||spoolBudget>maximumFrames*8)throw new Error('Invalid occasional export storage budget');
  if(!isAbsolute(options.workDirectory)||!isAbsolute(options.outputPath))throw new Error('Export storage requires internal absolute paths');
  const work=await lstat(options.workDirectory);if(!work.isDirectory()||work.isSymbolicLink())throw new Error('Export work storage must be a real directory');
  try{await lstat(options.outputPath);throw new Error('Export output already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const sources=new Map<string,{record:AssetRecord;path:string}>();
  for(const source of options.assets){const record=parseAssetRecord(source.record);if(sources.has(record.id))throw new Error('Duplicate export asset');sources.set(record.id,{record,path:source.path});}
  const ids=scenePlaybackAssetIds(scene);const inputs=new Map<string,{buffer:Pcm;path:string}>();let used=0;
  let lastProgress=-1;const report=(value:number)=>{value=Math.min(1,Math.max(0,value));if(value>=lastProgress+0.002||value===1){lastProgress=value;options.onProgress(value);}};
  const temporary=await mkdtemp(join(resolve(options.workDirectory),'render-'));await chmod(temporary,0o700);
  try{
    report(0);
    for(const [index,id] of ids.entries()){
      checkAbort(signal);const source=sources.get(id);if(!source||![1,2].includes(source.record.channels))throw new Error('Export asset is missing or not mono/stereo');
      await verifySource(source.path,source.record.sha256,signal);
      const path=join(temporary,`source-${index}.f32le`);const buffer=await decode(source.path,path,source.record.channels,budget-used,signal);
      used+=buffer.length*buffer.numberOfChannels*4;inputs.set(id,{buffer,path});report(0.25*(index+1)/ids.length);
    }
    if(transition)for(const [sideIndex,owner] of sides.entries()){
      if(listeningDuration(owner.listeningTimer,owner.durationSeconds)!==null||owner.layers.some(layer=>layer.loop||layer.occasional?.enabled))continue;
      // Match the live side's natural transport end, including muted layers. The
      // final side envelope retires EQ tails when its last finite source ends.
      const endpoint=Math.max(0,...owner.layers.map(layer=>Math.round(layer.startSeconds*rate)+inputs.get(layer.assetId)!.buffer.length));
      sideEnds[sideIndex]=endpoint;sideEndSeconds[sideIndex]=endpoint/rate;sideFrames[sideIndex]=Math.min(frames,endpoint);
    }
    const prepared=new Map<string,PreparedInput>();const sideInputs:PreparedInput[][]=[];
    const durations=new Map([...sources].map(([id,source])=>[id,source.record.durationSeconds]));
    // One full-length stereo Float32 RIFF horizon across all event spools.
    let spoolBytesRemaining=spoolBudget;
    for(const [sideIndex,owner] of sides.entries()){
      const layerInputs:PreparedInput[]=[];sideInputs.push(layerInputs);
      const endpoint=sideFrames[sideIndex]!,solo=owner.layers.some(layer=>layer.solo);
      for(const [index,layer] of owner.layers.entries()){
        if(layer.occasional?.enabled){
          const path=join(temporary,`occasional-${sideIndex}-${index}.f32le`);
          const audible=!layer.muted&&(!solo||layer.solo)&&layer.gain!==0&&Math.round(layer.startSeconds*rate)<endpoint;
          let length=0;
          if(audible){
            if(used+blockBytes>budget)throw budgetError();
            const result=await writeOccasional(path,layer,inputs,durations,endpoint,spoolBytesRemaining,signal,
              fraction=>report(.25+.05*(sideIndex+(index+fraction)/owner.layers.length)/sides.length),transition?sideEnds[sideIndex]:endpoint);
            length=result.frames;spoolBytesRemaining-=result.bytes;
          }
          layerInputs.push({path,channels:2,frames:length,introFrames:0,looping:false});continue;
        }
        const key=JSON.stringify([layer.assetId,layer.loop]);const old=prepared.get(key);if(old){layerInputs.push(old);continue;}
        const input=inputs.get(layer.assetId)!;let value:PreparedInput;
        if(layer.loop){
          const extra=loopExtraBytes(input.buffer,layer.loop);if(used+extra>budget)throw budgetError();
          const loop=prepareLoop(input.buffer,layer.loop,pcm);used+=extra;
          const introFrames=Math.round(loop.introSeconds*rate);const periodFrames=Math.round(loop.periodSeconds*rate);const path=join(temporary,`loop-${prepared.size}.f32le`);
          await writeLoop(path,input.buffer,loop,signal);value={path,channels:input.buffer.numberOfChannels,frames:introFrames+periodFrames,introFrames,looping:true};
        }else value={path:input.path,channels:input.buffer.numberOfChannels,frames:input.buffer.length,introFrames:0,looping:false};
        prepared.set(key,value);layerInputs.push(value);
      }
    }
    // Native rendering reads only the prepared files; do not retain a second JS copy of the PCM.
    inputs.clear();
    report(0.3);
    const args:string[]=[];const filters:string[]=[];
    let inputNumber=0;
    let nativeBytes=transition?TRANSITION_OUTPUT_STREAM_BUFFER_BYTES:processed?OUTPUT_STREAM_BUFFER_BYTES:0;
    if(nativeBytes>budget)throw budgetError();
    for(const [sideIndex,owner] of sides.entries()){
      const masterEq=equalizer(owner.masterEqualizer),labels:string[]=[];
      const endpoint=sideFrames[sideIndex]!,solo=owner.layers.some(layer=>layer.solo);
      const output=transition?`side${sideIndex}`:'out';
      const padding=endpoint<frames?`,apad=whole_len=${frames},atrim=end_sample=${frames}`:'';
      if(endpoint===0){filters.push(`anullsrc=r=${rate}:cl=stereo,atrim=end_sample=${frames}[${output}]`);continue;}
      nativeBytes+=masterEq.bands*blockBytes;
      if(nativeBytes>budget)throw budgetError();
      for(const [index,layer] of owner.layers.entries()){
        const input=sideInputs[sideIndex]![index]!;const start=Math.round(layer.startSeconds*rate);const length=Math.min(endpoint-start,input.looping?Infinity:input.frames);
        if(length<=0||layer.muted||(solo&&!layer.solo)||layer.gain===0)continue;
        const layerEq=equalizer(layer.equalizer);
        const movement=movementParameters(layer.pan,layer.movement);const moving=movement.radius>0;
        // aloop allocates two 8192-frame FIFOs; writes can grow one to twice its occupancy.
        // Reserve 3x payload for old+new allocations during growth. A split amix can queue
        // the whole intro; its other queue holds less than two 4096-frame raw-PCM packets.
        // Common adelay padding is emitted in blocks, with no intro-sized per-channel ring.
        const periodFrames=input.frames-input.introFrames;
        const loopFifoFrames=input.looping?Math.max(8192,3*periodFrames)+8192:0;
        const splitFifoFrames=input.introFrames>0?Math.max(1024,3*input.introFrames)+24576:0;
        const loopBytes=(loopFifoFrames+splitFifoFrames)*input.channels*4;
        // Keep bounded working blocks for the split branches and existing layer/EQ stages.
        // Moving pan adds double-planar input/output blocks (4096 stereo frames each).
        nativeBytes+=loopBytes+start*2*4+blockBytes*(1+layerEq.bands+(input.introFrames>0?2:0)+(moving?2:0));
        if(!Number.isSafeInteger(nativeBytes)||nativeBytes>budget)throw budgetError();
        const number=inputNumber++;args.push('-protocol_whitelist','file,pipe','-format_whitelist','f32le','-f','f32le','-ar',String(rate),'-ac',String(input.channels),'-threads','1','-i',input.path);
        let source=`[${number}:a]`;
        if(input.introFrames>0){
          // Nonzero aloop starts can omit a short final input packet from the repeat cache.
          // Loop a trimmed period from sample zero, then rejoin the unchanged intro using a
          // sample-count delay. concat timestamps would round some boundaries to microseconds.
          filters.push(`${source}asplit=2[introSource${number}][repeatSource${number}]`,
            `[introSource${number}]atrim=end_sample=${input.introFrames},asetpts=N/SR/TB[intro${number}]`,
            `[repeatSource${number}]atrim=start_sample=${input.introFrames}:end_sample=${input.frames},asetpts=N/SR/TB,aloop=loop=-1:size=${input.frames-input.introFrames}:start=0,adelay=${input.introFrames}S:all=1[repeat${number}]`,
            `[intro${number}][repeat${number}]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[loop${number}]`);
          source=`[loop${number}]`;
        }
        const repeat=input.looping&&input.introFrames===0?`aloop=loop=-1:size=${input.frames}:start=0,`:'';
        const pan=moving?movingPanFilter(input.channels,movement):panFilter(input.channels,layer.pan);
        // A finite source ends before the export horizon. Feed silence through its EQ so its
        // filter tail survives, then delay the complete layer instead of moving its envelope.
        const controls=layerEq.filter
          ? `apad=whole_len=${endpoint-start},atrim=end_sample=${endpoint-start},${layerEq.filter},volume=${layer.gain}:precision=float,${pan}`
          : moving?`volume=${layer.gain}:precision=float,${pan}`:`${pan},volume=${layer.gain}:precision=float`;
        // A transition export crops the saved side playback. Only the saved deadline or
        // natural source end owns its release; the requested file horizon adds no fade.
        const envelopeLength=transition?Math.min(sideEnds[sideIndex]!-start,input.looping?Infinity:input.frames):length;
        const edgeFade=layer.occasional?.enabled?'':envelope(envelopeLength,input.channels,length)+',';
        filters.push(`${source}${repeat}atrim=end_sample=${length},asetpts=N/SR/TB,${edgeFade}${controls},adelay=${start}S:all=1[layer${number}]`);
        labels.push(`[layer${number}]`);
      }
      if(masterEq.filter){
        const mix=labels.length?`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0`:`anullsrc=r=${rate}:cl=stereo`;
        filters.push(`${mix},apad=whole_len=${endpoint},atrim=end_sample=${endpoint},${masterEq.filter},volume=${owner.masterGain}:precision=float${padding}[${output}]`);
      }else{
        filters.push(labels.length?`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,volume=${owner.masterGain}:precision=float,apad=whole_len=${endpoint},atrim=end_sample=${endpoint}${padding}[${output}]`
          :`anullsrc=r=${rate}:cl=stereo,atrim=end_sample=${endpoint}${padding}[${output}]`);
      }
    }
    if(transition)filters.push('[side0][side1]join=inputs=2:channel_layout=quad:map=0.0-FL|0.1-FR|1.0-BL|1.1-BR[out]');
    args.push('-filter_complex',filters.join(';'),'-map','[out]','-ar',String(rate),'-ac',transition?'4':'2');
    // -ac alone chooses FFmpeg's default four-channel layout (4.0), which would
    // rematrix the rear channels. Keep the join's explicit quad ordering intact.
    if(transition)args.push('-channel_layout','quad');
    const progress=(seconds:number)=>report(0.3+0.55*Math.min(1,seconds/(frames/rate)));
    if(transition){
      args.push('-c:a','pcm_f32le','-threads','1','-f','f32le','-fflags','+bitexact','-progress','pipe:3','-stats_period','0.2','-nostats','pipe:1');
      await writeTransitionWav({outputPath:options.outputPath,frames,sampleRate:rate,scene,signal,
        sideEndSeconds:[sideEndSeconds[0]!,sideEndSeconds[1]!]},
        consume=>ffmpeg(args,signal,consume,progress));
    }else if(processed){
      // Retain the unclipped mix until the shared processor applies its ceiling,
      // then the listening envelope. The requested export endpoint owns the fade.
      args.push('-c:a','pcm_f32le','-threads','1','-f','f32le','-fflags','+bitexact','-progress','pipe:3','-stats_period','0.2','-nostats','pipe:1');
      await writeProcessedWav({outputPath:options.outputPath,frames,sampleRate:rate,settings:scene.outputLimiter,listeningTimer:scene.listeningTimer,signal},
        consume=>ffmpeg(args,signal,consume,progress));
    }else{
      // Preserve the existing native conversion and container bytes for legacy/disabled scenes.
      args.push('-c:a','pcm_s16le','-threads','1','-f','wav','-rf64','never','-map_metadata','-1','-fflags','+bitexact','-n','-progress','pipe:3','-stats_period','0.2','-nostats',options.outputPath);
      await ffmpeg(args,signal,undefined,progress);
    }
    await chmod(options.outputPath,0o600);report(0.85);
    return await validateOutput(options.outputPath,frames,signal,report);
  }finally{await rm(temporary,{recursive:true,force:true});}
}
