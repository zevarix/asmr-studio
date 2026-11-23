// Standalone feasibility experiment. It never edits the application or a user's browser.
// Usage: node dsp-feasibility.mjs ABS_REPO ABS_NEW_OUTPUT_DIRECTORY [FFMPEG_EXECUTABLE=ffmpeg]
// Inherit PLAYWRIGHT_BROWSERS_PATH when the existing browser cache requires it.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {isAbsolute,join,relative,resolve} from 'node:path';

const [repoArgument,outputArgument,ffmpegExecutable='ffmpeg']=process.argv.slice(2);
if(repoArgument==='--help'){
  console.log('node dsp-feasibility.mjs ABS_REPO ABS_NEW_OUTPUT_DIRECTORY [FFMPEG_EXECUTABLE=ffmpeg]');
  console.log('Uses the repo-installed Playwright Chromium in isolated headless mode; does not start the app.');
  console.log('Reports feasibility observations against unchanged 3 max / 0.75 RMS PCM16-step thresholds.');
  process.exit(0);
}
assert.ok(repoArgument&&outputArgument&&isAbsolute(repoArgument)&&isAbsolute(outputArgument),'Absolute repository and new output directory paths required');
assert.equal(Number(process.versions.node.split('.')[0]),22,'Use the supported Node 22 toolchain');
const repo=resolve(repoArgument),output=resolve(outputArgument),within=relative(repo,output);
assert.ok(within.startsWith('..')||isAbsolute(within),'Output must be outside the repository');
await readFile(join(repo,'package.json'));
await mkdir(output,{mode:0o700}); // Exclusive reservation: refuse an existing result directory.
process.umask(0o077);
const require=createRequire(join(repo,'package.json'));
const {chromium}=require('@playwright/test');
const sampleRate=48000,frames=sampleRate*2,tailFrames=sampleRate/4;
const thresholds={maxErrorPcm16:3,rmsErrorPcm16:.75};
const qDb=-3.010299956639812;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={status:'running',startedAt:new Date().toISOString(),node:process.version,platform:process.platform,
  source:null,browser:null,ffmpeg:null,sampleRate,inputFrames:frames,thresholds,
  comparison:'FFmpeg PCM16 against native Float32, both scaled in PCM16 steps; no alignment, normalization, or threshold adjustment',
  sources:{webAudio:'https://www.w3.org/TR/webaudio-1.1/#filters-characteristics',
    nativeRate:'https://www.w3.org/TR/webaudio-1.1/#playback-AudioBuffer-contents',ffmpegRate:'https://ffmpeg.org/ffmpeg-filters.html#asetrate'},
  fixtures:[],cases:[],cleanup:{browserClosed:false,ffmpegChildren:0}};
const controller=new AbortController(),children=new Set();
let browser=null;
const interrupt=()=>{controller.abort(new Error('Experiment interrupted'));void browser?.close().catch(()=>{});};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const deadline=setTimeout(()=>{controller.abort(new Error('Experiment exceeded 180 seconds'));void browser?.close().catch(()=>{});},180000);

function check(){if(controller.signal.aborted)throw controller.signal.reason;}
async function ffmpeg(args,maxBytes=4*1024*1024){
  check();
  const child=spawn(ffmpegExecutable,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
  children.add(child);
  const chunks=[];let size=0,stderr='',failure=null;
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){failure=new Error('FFmpeg output exceeded experiment bound');child.kill();}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);});
  const exit=await new Promise(resolve=>{
    child.once('error',error=>{failure??=error;});
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  children.delete(child);
  if(failure)throw failure;
  assert.equal(exit.code,0,'FFmpeg failed: '+stderr);
  return {bytes:Buffer.concat(chunks),stderr};
}

function inputFixture(kind){
  const raw=Buffer.alloc(frames*4);let seed=0x71c34b9d;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/0x100000000*2-1;};
  let peak=0;
  for(let frame=0;frame<frames;frame++){
    const t=frame/sampleRate;
    let left=0,right=0;
    if(kind==='broadband'){
      left=.19*random()+.07*Math.sin(2*Math.PI*43*t);
      right=.17*random()+.06*Math.sin(2*Math.PI*71*t);
    }else if(kind==='impulses'){
      if([0,127,24000,72000].includes(frame)){left=.4;right=-.3;}
      if([61,4096,48000].includes(frame)){left=-.2;right=.35;}
    }else if(kind==='tones'){
      left=.12*Math.sin(2*Math.PI*30*t)+.08*Math.sin(2*Math.PI*60*t)+.06*Math.sin(2*Math.PI*1000*t);
      right=.11*Math.sin(2*Math.PI*47*t)+.07*Math.sin(2*Math.PI*120*t)+.06*Math.sin(2*Math.PI*2200*t);
    }else throw new Error('Unknown fixture');
    peak=Math.max(peak,Math.abs(left),Math.abs(right));
    raw.writeInt16LE(Math.round(left*32768),frame*4);raw.writeInt16LE(Math.round(right*32768),frame*4+2);
  }
  assert.ok(peak>.01&&peak<.9,'Fixture must be audible and unclipped');
  return raw;
}
function highpass(frequency){
  const f=Math.fround(frequency),Q=Math.fround(qDb),omega=2*Math.PI*f/sampleRate;
  const cosine=Math.cos(omega),alpha=Math.sin(omega)/(2*10**(Q/20));
  return {frequency:f,qDb:Q,coefficients:{b0:(1+cosine)/2,b1:-(1+cosine),b2:(1+cosine)/2,a0:1+alpha,a1:-2*cosine,a2:1-alpha}};
}
function metrics(native,actual,start,end){
  const output=[];
  for(let channel=0;channel<2;channel++){
    let maximum=0,squares=0,worstFrame=start,referencePeak=0,actualPeak=0;
    for(let frame=start;frame<end;frame++){
      const reference=native.readFloatLE((frame*2+channel)*4),value=actual.readInt16LE((frame*2+channel)*2)/32768;
      assert.ok(Number.isFinite(reference),'Non-finite native sample');
      const error=Math.abs(value-reference)*32768;
      if(error>maximum){maximum=error;worstFrame=frame;}squares+=error*error;
      referencePeak=Math.max(referencePeak,Math.abs(reference));actualPeak=Math.max(actualPeak,Math.abs(value));
    }
    output.push({channel:channel===0?'left':'right',frames:end-start,maxErrorPcm16:maximum,
      rmsErrorPcm16:Math.sqrt(squares/(end-start)),worstFrame,worstAtSeconds:worstFrame/sampleRate,referencePeak,actualPeak});
  }
  return output;
}

try{
  const git=spawnSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});
  report.source={repositoryCommit:git.status===0?git.stdout.trim():null,repoUsedOnlyFor:'existing Playwright package'};
  const version=await ffmpeg(['-version'],1024*1024);report.ffmpeg=version.bytes.toString().split('\n')[0];
  browser=await chromium.launch({headless:true});report.browser=browser.version();
  const page=await browser.newPage();page.setDefaultTimeout(30000);
  await page.goto('about:blank');
  const cases=[{name:'identity',kind:'identity'},
    {name:'highpass-40',kind:'highpass',frequency:40},
    {name:'highpass-80',kind:'highpass',frequency:80},
    {name:'speed-085',kind:'speed',ratio:.85},
    {name:'speed-115',kind:'speed',ratio:1.15}];
  for(const fixture of ['broadband','impulses','tones']){
    const input=inputFixture(fixture),inputPath=join(output,fixture+'-input.s16le');
    await writeFile(inputPath,input,{flag:'wx'});
    report.fixtures.push({name:fixture,frames,channels:2,encoding:'signed PCM16 little-endian, interleaved',sha256:hash(input),bytes:input.length});
    for(const setting of cases){
      check();
      const effectiveRatio=setting.kind==='speed'?Math.fround(setting.ratio):1;
      const outputFrames=Math.ceil(frames/effectiveRatio)+tailFrames;
      const nativeResult=await page.evaluate(async({base64,sampleRate,frames,outputFrames,setting,qDb})=>{
        const input=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const view=new DataView(input.buffer);
        const context=new OfflineAudioContext(2,outputFrames,sampleRate);
        const buffer=context.createBuffer(2,frames,sampleRate);
        for(let channel=0;channel<2;channel++){
          const data=buffer.getChannelData(channel);
          for(let frame=0;frame<frames;frame++)data[frame]=view.getInt16((frame*2+channel)*2,true)/32768;
        }
        const source=context.createBufferSource();source.buffer=buffer;
        let filter=null,parameters={};
        if(setting.kind==='highpass'){
          filter=context.createBiquadFilter();filter.type='highpass';filter.frequency.value=setting.frequency;
          filter.Q.value=qDb;filter.detune.value=0;
          parameters={frequency:filter.frequency.value,qDb:filter.Q.value,detune:filter.detune.value};
          source.connect(filter);filter.connect(context.destination);
        }else{
          source.playbackRate.value=setting.kind==='speed'?setting.ratio:1;
          parameters={playbackRate:source.playbackRate.value};source.connect(context.destination);
        }
        source.start(0);
        try{
          const rendered=await context.startRendering();
          const bytes=new Uint8Array(rendered.length*8),out=new DataView(bytes.buffer);
          for(let channel=0;channel<2;channel++){
            const data=rendered.getChannelData(channel);
            for(let frame=0;frame<rendered.length;frame++)out.setFloat32((frame*2+channel)*4,data[frame],true);
          }
          let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));
          return {parameters,frames:rendered.length,base64:btoa(binary)};
        }finally{source.disconnect();filter?.disconnect();source.buffer=null;}
      },{base64:input.toString('base64'),sampleRate,frames,outputFrames,setting,qDb});
      const native=Buffer.from(nativeResult.base64,'base64');assert.equal(native.length,outputFrames*8);
      let filter='aformat=sample_fmts=fltp:channel_layouts=stereo';
      let parameters=null;
      if(setting.kind==='highpass'){
        parameters=highpass(setting.frequency);const c=parameters.coefficients;
        assert.equal(nativeResult.parameters.frequency,parameters.frequency);assert.equal(nativeResult.parameters.qDb,parameters.qDb);
        // Match existing exporter precision/state choices: double filter state, Float32 node boundaries.
        filter+=`,apad=whole_len=${outputFrames},atrim=end_sample=${outputFrames},biquad=a0=${c.a0}:a1=${c.a1}:a2=${c.a2}:b0=${c.b0}:b1=${c.b1}:b2=${c.b2}:normalize=0:transform=di:precision=f64:blocksize=0,aformat=sample_fmts=fltp`;
      }else if(setting.kind==='speed'){
        const integerRate=Math.round(sampleRate*setting.ratio);
        parameters={requestedRatio:setting.ratio,nativeFloat32Ratio:effectiveRatio,ffmpegIntegerRate:integerRate,ffmpegRatio:integerRate/sampleRate};
        assert.equal(nativeResult.parameters.playbackRate,effectiveRatio);
        filter+=`,asetrate=${integerRate},aresample=${sampleRate}:dither_method=none,apad=whole_len=${outputFrames},atrim=end_sample=${outputFrames}`;
      }else filter+=`,apad=whole_len=${outputFrames},atrim=end_sample=${outputFrames}`;
      const result=await ffmpeg(['-nostdin','-hide_banner','-loglevel','error','-filter_threads','1','-filter_complex_threads','1',
        '-f','s16le','-ar',String(sampleRate),'-ac','2','-i',inputPath,'-af',filter,'-ar',String(sampleRate),'-ac','2',
        '-c:a','pcm_s16le','-threads','1','-f','s16le','pipe:1']);
      const actual=result.bytes;assert.equal(actual.length,outputFrames*4,'FFmpeg frame count differs');
      const channels=metrics(native,actual,0,outputFrames);
      const interiorStart=Math.round(.05*sampleRate),interiorEnd=Math.floor(frames/effectiveRatio)-interiorStart;
      const interiorChannels=metrics(native,actual,interiorStart,interiorEnd);
      const withinThresholds=channels.every(c=>c.maxErrorPcm16<=thresholds.maxErrorPcm16&&c.rmsErrorPcm16<=thresholds.rmsErrorPcm16);
      const stem=fixture+'-'+setting.name;
      await writeFile(join(output,stem+'-native.f32le'),native,{flag:'wx'});
      await writeFile(join(output,stem+'-ffmpeg.s16le'),actual,{flag:'wx'});
      const record={fixture,name:setting.name,kind:setting.kind,parameters,nativeParameters:nativeResult.parameters,outputFrames,
        durationSeconds:outputFrames/sampleRate,filter,withinThresholds,channels,
        interior:{startFrame:interiorStart,endFrame:interiorEnd,diagnosticOnly:true,channels:interiorChannels},
        artifacts:{native:{file:stem+'-native.f32le',bytes:native.length,sha256:hash(native)},
          ffmpeg:{file:stem+'-ffmpeg.s16le',bytes:actual.length,sha256:hash(actual)}}};
      report.cases.push(record);
      console.log(JSON.stringify({fixture,name:setting.name,withinThresholds,channels}));
      // Baseline failure invalidates subsequent comparisons. Treatment failures are the requested observations.
      if(setting.kind==='identity')assert.ok(withinThresholds,'Identity baseline failed');
    }
  }
  report.status='completed';report.summary=Object.fromEntries(['identity','highpass','speed'].map(kind=>{
    const cases=report.cases.filter(c=>c.kind===kind);
    return [kind,{cases:cases.length,withinThresholds:cases.filter(c=>c.withinThresholds).length,
      maxErrorPcm16:Math.max(...cases.flatMap(c=>c.channels.map(ch=>ch.maxErrorPcm16))),
      maxRmsErrorPcm16:Math.max(...cases.flatMap(c=>c.channels.map(ch=>ch.rmsErrorPcm16)))}];
  }));
}catch(error){report.status='error';report.error=error.stack??String(error);process.exitCode=1;}
finally{
  clearTimeout(deadline);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  if(browser){try{await browser.close();report.cleanup.browserClosed=true;}catch(error){report.cleanup.browserError=String(error);process.exitCode=1;}}
  for(const child of children)child.kill();
  report.cleanup.ffmpegChildren=children.size;
  if(children.size){report.status='error';report.error??='Owned FFmpeg children remain';process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:report.status,summary:report.summary,cleanup:report.cleanup,error:report.error}));
}
