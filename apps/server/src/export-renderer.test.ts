import {afterEach,describe,expect,it,vi} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createEmptyScene,createEmptyTransition,layerAssetIds,type AssetRecord,type Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../../../tests/fixtures/audio.js';
import {fixtureLayer} from '../../../tests/fixtures/scene.js';
import {decodePcm16Wav,exportToneFixture,samplePeak,toneAmplitude} from '../../../tests/fixtures/export.js';
import {renderWav} from './export-renderer.js';

vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});

const roots:string[]=[];
async function fixture(options:{channels?:1|2;frames?:number;varying?:boolean}={}){
  const root=await mkdtemp(join(tmpdir(),'asmr-render-'));roots.push(root);
  const channels=options.channels??2;const frames=options.frames??4800;
  const bytes=wavFixture({channels,frames,sampleRate:48000});
  if(options.varying){const view=new DataView(bytes.buffer);for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++)view.setInt16(44+(frame*channels+channel)*2,(channel===0?1:-1)*(200+(frame%251)*17),true);}
  const path=join(root,'source.wav');await writeFile(path,bytes);
  const record:AssetRecord={id:'recording',sha256:createHash('sha256').update(bytes).digest('hex'),displayName:'Fixture',roles:['texture'],durationSeconds:frames/48000,sampleRate:48000,channels,format:'wav',provenance:{kind:'original',source:null},rights:{privateUse:'permitted',redistribution:'permitted'}};
  const scene:Scene={...createEmptyScene('export','Export fixture'),masterGain:1,layers:[fixtureLayer({assetId:record.id,gain:1})]};
  return {root,bytes,record,scene,assets:[{record,path}],workDirectory:root,outputPath:join(root,'finished.wav'),signal:new AbortController().signal,onProgress:(_progress:number)=>{}};
}
function capturedTransition(input:Awaited<ReturnType<typeof fixture>>):Scene {
  const value=createEmptyTransition('arrangement','Transition');value.outputLimiter={enabled:false,ceilingDb:-1};
  const ids=new Set(input.scene.layers.flatMap(layerAssetIds));
  const records=input.assets.filter(asset=>ids.has(asset.record.id)).map(asset=>asset.record);
  value.transition!.a={id:'capture-a',scene:structuredClone({...input.scene,id:'source-a',revision:1}),assets:structuredClone(records)};
  value.transition!.b={id:'capture-b',scene:structuredClone({...input.scene,id:'source-b',revision:1}),assets:structuredClone(records)};
  return value;
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

async function cancelSpawnedRender(input:Awaited<ReturnType<typeof fixture>>):Promise<void>{
  const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const controller=new AbortController(),events:string[]=[];
  const children:ChildProcess[]=[];let runningAtAbort=false;
  // Fast native renders can finish before their first progress report. Observe
  // the real owned process instead of relying on FFmpeg speed or progress timing.
  const spawnMock=vi.mocked(spawn).mockImplementation((...args)=>{
    const child=actual.spawn(...args);children.push(child);
    child.once('close',()=>events.push('close'));
    child.once('spawn',()=>{
      events.push('spawn');runningAtAbort=child.exitCode===null&&child.signalCode===null;
      controller.abort();
    });
    return child;
  });
  try{
    const rendering=renderWav({...input,durationSeconds:1,signal:controller.signal}).catch(error=>{events.push('rejected');throw error;});
    await expect(rendering).rejects.toMatchObject({name:'AbortError'});
    expect(children).toHaveLength(1);expect(children[0]!.pid).toBeGreaterThan(0);
    expect(runningAtAbort).toBe(true);expect(controller.signal.aborted).toBe(true);
    expect(events).toEqual(['spawn','close','rejected']);
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
    expect((await readdir(input.root)).some(name=>name.startsWith('render-'))).toBe(false);
  }finally{spawnMock.mockImplementation(actual.spawn);}
}

describe('finite FFmpeg WAV rendering',()=>{
  const occasional={enabled:true,minPauseSeconds:.25,maxPauseSeconds:.25,seed:12,alternateAssetIds:['alternate'],levelVariation:.25,panVariation:.25};
  it('renders the seeded mono/stereo clip windows through the saved layer controls and fades the clipped endpoint',async()=>{
    const input=await fixture(),alt=await fixture({channels:1,frames:2400});
    input.assets.push({record:{...alt.record,id:'alternate'},path:alt.assets[0]!.path});
    const layer=input.scene.layers[0]!;
    Object.assign(layer,{startSeconds:.025,gain:.7,pan:.4,occasional,loop:{startSeconds:.03,endSeconds:.07,crossfadeSeconds:0}});
    input.scene.masterGain=.8;
    await renderWav({...input,durationSeconds:.69});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(output.frames).toBe(33120);
    for(const channel of output.channelData){
      expect(samplePeak(channel,0,1200)).toBe(0);
      expect(samplePeak(channel,3600,15600)).toBe(0);
      expect(samplePeak(channel,20400,32400)).toBe(0);
    }
    // Independent golden windows and per-event controls for seed 12.
    for(const event of [
      {start:1200,length:2400,mono:true,pan:.1491835564,gain:.9253335595},
      {start:15600,length:4800,mono:false,pan:-.047025878,gain:.9295544028},
      {start:32400,length:720,mono:true,pan:.129039541,gain:.8395292759},
    ]){
      const angle=event.mono?(event.pan+1)*Math.PI/4:(event.pan+1)*Math.PI/2;
      const l=event.mono?1200*Math.cos(angle):1200-600*Math.cos(angle);
      const r=event.mono?1200*Math.sin(angle):-600*Math.sin(angle);
      const layerAngle=.4*Math.PI/2;
      const stereo=[l*Math.cos(layerAngle),r+l*Math.sin(layerAngle)];
      const fade=Math.min(960,event.length/2);
      for(const at of [0,Math.floor(fade/2),Math.floor(event.length/2),event.length-1]){
        const level=.8*.7*event.gain*Math.min(1,at/fade,(event.length-at)/fade);
        for(const [ch,value] of stereo.entries()){
          expect(Math.abs(output.channelData[ch]![event.start+at]!*32768-value*level)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
  it('preserves exact legacy loop and one-shot WAV bytes with disabled occasional controls',async()=>{
    const input=await fixture({varying:true}),layer=input.scene.layers[0]!;
    // Disabled alternates are included in a durable recipe but need no decode here.
    for(const loop of [null,{startSeconds:.02,endSeconds:.07,crossfadeSeconds:.01}]){
      layer.loop=loop;delete layer.occasional;
      const reference=join(input.root,loop?'loop.wav':'one-shot.wav');
      await renderWav({...input,durationSeconds:.2,outputPath:reference});
      layer.occasional={...occasional,enabled:false};
      const outputPath=reference+'.disabled.wav';
      await renderWav({...input,durationSeconds:.2,outputPath});
      expect(await readFile(outputPath)).toEqual(await readFile(reference));
    }
  });
  it('counts active alternates and the spool block against memory and cancels during event preparation',async()=>{
    const input=await fixture({frames:24000}),alt=await fixture({frames:4800});
    input.assets.push({record:{...alt.record,id:'alternate'},path:alt.assets[0]!.path});
    input.scene.layers[0]!.occasional=occasional;
    for(const decodedBudgetBytes of [195000,240000]){
      await expect(renderWav({...input,durationSeconds:2,decodedBudgetBytes})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    }
    const controller=new AbortController();
    await expect(renderWav({...input,durationSeconds:2,signal:controller.signal,onProgress:progress=>{
      if(progress>.25&&progress<.3)controller.abort();
    }})).rejects.toMatchObject({name:'AbortError'});
    expect(await readdir(input.root)).toEqual(['source.wav']);
  });
  it('charges silent gaps to the temporary-file limit and removes incomplete event files',async()=>{
    const input=await fixture({frames:8});
    input.scene.layers[0]!.occasional={...occasional,alternateAssetIds:[]};
    // The clips contain only 64 bytes each, but their intervening gap extends the file.
    await expect(renderWav({...input,durationSeconds:.7,occasionalSpoolBudgetBytes:32000})).rejects.toMatchObject({code:'EXPORT_STORAGE_BUDGET'});
    expect(await readdir(input.root)).toEqual(['source.wav']);
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
  });
  it('applies long fades to the selected export endpoint without changing a saved listening timer',async()=>{
    const input=await fixture();input.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:0};
    input.scene.listeningTimer={enabled:true,durationSeconds:3,fadeInSeconds:.1,fadeOutSeconds:.2};
    const before=structuredClone(input.scene);
    const result=await renderWav({...input,durationSeconds:.5});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(result.durationSeconds).toBe(.5);expect(output.frames).toBe(24000);expect(input.scene).toEqual(before);
    for(const [time,gain] of [[.05,.5],[.1,1],[.25,1],[.35,.75],[.4,.5],[.45,.25]] as const){
      const frame=Math.round(time*48000);
      expect(Math.abs(output.channelData[0]![frame]!-1200/32768*gain)).toBeLessThanOrEqual(1/32768);
      expect(Math.abs(output.channelData[1]![frame]!+600/32768*gain)).toBeLessThanOrEqual(1/32768);
    }
    expect(output.channelData.map(channel=>channel[0])).toEqual([0,0]);
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
  });
  it('retains exact native WAV bytes when long fades are absent, disabled, or zero',async()=>{
    const input=await fixture({varying:true});await renderWav({...input,durationSeconds:.2});
    const original=await readFile(input.outputPath);
    for(const [name,listeningTimer] of Object.entries({
      disabled:{enabled:false,durationSeconds:2700,fadeInSeconds:60,fadeOutSeconds:180},
      zero:{enabled:true,durationSeconds:2700,fadeInSeconds:0,fadeOutSeconds:0},
    })){
      input.scene.listeningTimer=listeningTimer;const outputPath=join(input.root,name+'-timer.wav');
      await renderWav({...input,durationSeconds:.2,outputPath});expect(await readFile(outputPath)).toEqual(original);
    }
  });
  it('allows triangular long fades in a very short export without changing its final frame count',async()=>{
    const input=await fixture({frames:4800});input.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:0};
    const frames=3,fade=frames/(2*48000);
    input.scene.listeningTimer={enabled:true,durationSeconds:1,fadeInSeconds:fade,fadeOutSeconds:fade};
    await renderWav({...input,durationSeconds:frames/48000});const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(output.frames).toBe(frames);
    for(let frame=0;frame<frames;frame++)for(let channel=0;channel<2;channel++){
      const envelope=Math.min(frame/1.5,(3-frame)/1.5);
      const source=(channel===0?1200:-600)/32768;
      // The independent short source envelope and long listening envelope multiply.
      expect(Math.abs(output.channelData[channel]![frame]!-source*envelope*envelope)).toBeLessThanOrEqual(1/32768);
    }
  });
  it('does not prolong natural clip endings or fill silent padding when long fades are active',async()=>{
    const input=await fixture({frames:2400});input.scene.layers[0]!.startSeconds=.025;
    input.scene.listeningTimer={enabled:true,durationSeconds:10,fadeInSeconds:.05,fadeOutSeconds:.1};
    await renderWav({...input,durationSeconds:.25});const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(output.frames).toBe(12000);
    for(const samples of output.channelData){
      expect(samplePeak(samples,0,1200)).toBe(0);expect(samplePeak(samples,1200,3600)).toBeGreaterThan(.005);
      expect(samplePeak(samples,3600)).toBe(0);
    }
  });
  it('rejects fades that do not fit the actual render before touching output storage or spawning FFmpeg',async()=>{
    const input=await fixture();input.scene.listeningTimer={enabled:true,durationSeconds:1,fadeInSeconds:.2,fadeOutSeconds:.3};
    const calls=vi.mocked(spawn).mock.calls.length;
    await expect(renderWav({...input,workDirectory:join(input.root,'does-not-exist'),durationSeconds:.4})).rejects.toMatchObject({code:'EXPORT_FADE_INVALID'});
    expect(vi.mocked(spawn).mock.calls).toHaveLength(calls);expect(await readdir(input.root)).toEqual(['source.wav']);
  });
  it('preserves stereo gain, delayed timing, finite fades and original bytes with verified output metadata',async()=>{
    const input=await fixture();const progress:number[]=[];
    input.scene.masterGain=.5;input.scene.durationSeconds=.01;input.scene.layers[0]!.gain=.5;input.scene.layers[0]!.startSeconds=.025;
    const result=await renderWav({...input,durationSeconds:.2,onProgress:value=>progress.push(value)});
    const bytes=await readFile(input.outputPath);const decoded=decodePcm16Wav(bytes);
    expect(result).toMatchObject({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),durationSeconds:.2,sampleRate:48000,channels:2,clippedSamples:0});
    expect(decoded.frames).toBe(9600);
    for(let frame=0;frame<decoded.frames;frame++){
      const relative=frame-1200;const fade=Math.max(0,Math.min(1,relative/960,(4800-relative)/960));
      expect(Math.abs(decoded.channelData[0]![frame]!-1200/32768*.25*fade)).toBeLessThanOrEqual(1/32768);
      expect(Math.abs(decoded.channelData[1]![frame]!+600/32768*.25*fade)).toBeLessThanOrEqual(1/32768);
    }
    expect(result.peak).toBeCloseTo(300/32768,5);expect(result.rms).toBeGreaterThan(0);
    expect(progress[0]).toBe(0);expect(progress.at(-1)).toBe(1);expect(progress.every((value,index)=>index===0||value>=progress[index-1]!)).toBe(true);
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
    expect((await readdir(input.root)).sort()).toEqual(['finished.wav','source.wav']);
  });
  it.each([
    {name:'short stereo',channels:2 as const,start:100,end:1300,crossfade:240,exportFrames:4800},
    {name:'stereo with a partial final input packet',channels:2 as const,start:1200,end:9600,crossfade:1200,exportFrames:19001},
    {name:'mono with a partial final input packet',channels:1 as const,start:17,end:8210,crossfade:2048,exportFrames:20003},
    {name:'one-frame crossfade',channels:2 as const,start:3,end:6,crossfade:1,exportFrames:7},
    {name:'intro-only',channels:2 as const,start:1200,end:9600,crossfade:1200,exportFrames:3},
  ])('plays the $name intro once, then repeats the complete linear overlap period',async({channels,start,end,crossfade,exportFrames})=>{
    const input=await fixture({channels,frames:end+100,varying:true});const length=end-start,period=length-crossfade;
    input.scene.layers[0]!.loop={startSeconds:start/48000,endSeconds:end/48000,crossfadeSeconds:crossfade/48000};
    await renderWav({...input,durationSeconds:exportFrames/48000});const output=decodePcm16Wav(await readFile(input.outputPath));const source=decodePcm16Wav(input.bytes);
    expect(output.frames).toBe(exportFrames);
    for(let frame=0;frame<exportFrames;frame++)for(let channel=0;channel<2;channel++){
      const samples=source.channelData[channels===1?0:channel]!;let value:number;
      if(frame<crossfade)value=samples[start+frame]!;
      else{
        const phase=(frame-crossfade)%period;const direct=length-2*crossfade;
        if(phase<direct)value=samples[start+crossfade+phase]!;
        else{const i=phase-direct,weight=(i+1)/crossfade;value=samples[end-crossfade+i]!*(1-weight)+samples[start+i]!*weight;}
      }
      const fade=Math.min(960,exportFrames/2);const envelope=Math.min(1,frame/fade,(exportFrames-frame)/fade);
      const pan=channels===1?Math.SQRT1_2:1;
      expect(Math.abs(output.channelData[channel]![frame]!-value*envelope*pan)).toBeLessThanOrEqual(1/32768);
    }
  });
  it('preserves mono equal-power pan, mute/solo and the half-sample fade midpoint of a three-frame clip',async()=>{
    const input=await fixture({channels:1,frames:3});input.scene.layers=[
      fixtureLayer({assetId:input.record.id,gain:1,solo:true}),
      fixtureLayer({id:'excluded',assetId:input.record.id,gain:1,pan:1}),
      fixtureLayer({id:'muted',assetId:input.record.id,gain:1,solo:true,muted:true}),
    ];
    await renderWav({...input,durationSeconds:10/48000});const output=decodePcm16Wav(await readFile(input.outputPath));
    for(const channel of output.channelData)for(let frame=0;frame<10;frame++){
      const envelope=Math.max(0,Math.min(1,frame/1.5,(3-frame)/1.5));
      expect(Math.abs(channel[frame]!-1200/32768*Math.SQRT1_2*envelope)).toBeLessThanOrEqual(1/32768);
    }
  });
  it.each([1,2] as const)('moves a delayed %i-channel loop through both pan directions without resetting at each repeat',async channels=>{
    const input=await fixture({channels});
    input.scene.layers[0]!.pan=.25;
    input.scene.layers[0]!.startSeconds=.125;
    input.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:0};
    input.scene.layers[0]!.movement={enabled:true,width:.75,cycleSeconds:2};
    await renderWav({...input,durationSeconds:2.25});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(output.frames).toBe(108000);
    for(const samples of output.channelData)expect(samplePeak(samples,0,6000)).toBe(0);
    const left=1200/32768,right=-600/32768;
    // The 2-second cycle has literal quarter-cycle positions: +1, +.25, -.5, +.25.
    // These checks catch a static pan, a scene-wide phase, and a phase reset at each .1s sound loop.
    const center=channels===1
      ? [left*Math.cos(5*Math.PI/16),left*Math.sin(5*Math.PI/16)]
      : [left*Math.cos(Math.PI/8),right+left*Math.sin(Math.PI/8)];
    const wanted=[
      {at:.5,values:channels===1?[0,left]:[0,left+right]},
      {at:1,values:center},
      {at:1.5,values:channels===1?[left*Math.cos(Math.PI/8),left*Math.sin(Math.PI/8)]:[left+right*Math.SQRT1_2,right*Math.SQRT1_2]},
      {at:2,values:center},
    ];
    for(const point of wanted)for(let channel=0;channel<2;channel++){
      const frame=6000+Math.round(point.at*48000);
      expect(Math.abs(output.channelData[channel]![frame]!-point.values[channel]!)).toBeLessThanOrEqual(1/32768);
    }
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
  });
  it.each([
    {name:'disabled movement',pan:.37,movement:{enabled:false,width:.8,cycleSeconds:2}},
    {name:'zero movement width',pan:-.37,movement:{enabled:true,width:0,cycleSeconds:2}},
    {name:'left-edge center',pan:-1,movement:{enabled:true,width:1,cycleSeconds:2}},
    {name:'right-edge center',pan:1,movement:{enabled:true,width:1,cycleSeconds:2}},
  ])('keeps $name byte-identical to its static stereo position',async({pan,movement})=>{
    const input=await fixture({varying:true});input.scene.layers[0]!.pan=pan;
    await renderWav({...input,durationSeconds:.2});const original=await readFile(input.outputPath);
    input.scene.layers[0]!.movement=movement;
    const outputPath=join(input.root,'neutral-movement.wav');
    await renderWav({...input,outputPath,durationSeconds:.2});
    expect(await readFile(outputPath)).toEqual(original);
  });
  it('reserves dynamic panning buffers only while a layer actually moves',async()=>{
    const input=await fixture({varying:true});
    input.scene.layers[0]!.movement={enabled:true,width:0,cycleSeconds:2};
    await renderWav({...input,durationSeconds:.15,decodedBudgetBytes:150000,outputPath:join(input.root,'static.wav')});
    input.scene.layers[0]!.movement.width=.3;
    await expect(renderWav({...input,durationSeconds:.15,decodedBudgetBytes:150000})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    const result=await renderWav({...input,durationSeconds:.15,decodedBudgetBytes:256000});
    expect(result).toMatchObject({durationSeconds:.15,channels:2,clippedSamples:0});
  });
  it('writes a finite silent empty scene and counts full-scale output without automatic normalization',async()=>{
    const empty=await fixture();empty.scene.layers=[];
    const silence=await renderWav({...empty,durationSeconds:1/48000});expect(silence).toMatchObject({peak:0,rms:0,clippedSamples:0,durationSeconds:1/48000});
    const loud=await fixture();loud.scene.layers=Array.from({length:32},(_,index)=>fixtureLayer({id:String(index),assetId:loud.record.id,gain:1,pan:0}));
    const result=await renderWav({...loud,durationSeconds:.1});expect(result.clippedSamples).toBeGreaterThan(0);expect(result.peak).toBeGreaterThan(.99);
  });
  it('combines per-layer and master equalizer response without normalizing bass or treble gain',async()=>{
    const input=await fixture({channels:1,frames:60000});const frequencies=[80,1000,8000];
    const bytes=exportToneFixture({frames:60000,channels:1,frequencies,amplitude:.025});
    await writeFile(input.assets[0]!.path,bytes);input.record.sha256=createHash('sha256').update(bytes).digest('hex');
    input.scene.masterGain=.65;input.scene.layers[0]!.gain=.7;
    await renderWav({...input,durationSeconds:1.5});const flat=decodePcm16Wav(await readFile(input.outputPath));
    input.scene.layers[0]!.equalizer={bassDb:6,midDb:-6,trebleDb:6,bypassed:false};
    input.scene.masterEqualizer={bassDb:0,midDb:3,trebleDb:0,bypassed:false};
    const outputPath=join(input.root,'equalized.wav');
    const result=await renderWav({...input,outputPath,durationSeconds:1.5});const changed=decodePcm16Wav(await readFile(outputPath));
    const response=frequencies.map(frequency=>20*Math.log10(toneAmplitude(changed.channelData[0]!,frequency,12000,48000)/toneAmplitude(flat.channelData[0]!,frequency,12000,48000)));
    expect(response[0]).toBeGreaterThan(5);expect(response[0]).toBeLessThan(6.3);
    expect(response[1]).toBeCloseTo(-3,0);
    expect(response[2]).toBeGreaterThan(5);expect(response[2]).toBeLessThan(6.3);
    expect(result.clippedSamples).toBe(0);expect(result.peak).toBeLessThan(.2);
  });
  it.each([1,2] as const)('applies master EQ to both output channels after moving a %i-channel source',async channels=>{
    const input=await fixture({channels,frames:60000}),frequencies=[80,1000,8000];
    const bytes=exportToneFixture({frames:60000,channels,frequencies,amplitude:.015});
    await writeFile(input.assets[0]!.path,bytes);input.record.sha256=createHash('sha256').update(bytes).digest('hex');
    input.scene.masterGain=.65;input.scene.layers[0]!.gain=.7;input.scene.layers[0]!.pan=.2;
    input.scene.layers[0]!.movement={enabled:true,width:.7,cycleSeconds:2};
    input.scene.layers[0]!.equalizer={bassDb:3,midDb:-2,trebleDb:4,bypassed:false};
    await renderWav({...input,durationSeconds:1.5});const flat=decodePcm16Wav(await readFile(input.outputPath));
    input.scene.masterEqualizer={bassDb:6,midDb:-6,trebleDb:6,bypassed:false};
    const outputPath=join(input.root,'moving-master-eq.wav');
    await renderWav({...input,outputPath,durationSeconds:1.5});const changed=decodePcm16Wav(await readFile(outputPath));
    // Measure the audible band response, including channel layouts used by downstream filters.
    // Movement is identical in both renders, so it cannot conceal a bypassed master equalizer.
    for(let channel=0;channel<2;channel++){
      const response=frequencies.map(frequency=>20*Math.log10(toneAmplitude(changed.channelData[channel]!,frequency,12000,48000)/toneAmplitude(flat.channelData[channel]!,frequency,12000,48000)));
      expect(response[0]).toBeGreaterThan(5);expect(response[0]).toBeLessThan(6.3);
      expect(response[1]).toBeCloseTo(-6,0);
      expect(response[2]).toBeGreaterThan(5);expect(response[2]).toBeLessThan(6.3);
    }
  });
  it('keeps flat and bypassed equalizers byte-identical to the original no-EQ export',async()=>{
    const input=await fixture({varying:true});await renderWav({...input,durationSeconds:.2});const original=await readFile(input.outputPath);
    for(const [name,equalizer] of Object.entries({flat:{bassDb:0,midDb:0,trebleDb:0,bypassed:false},bypass:{bassDb:12,midDb:-9,trebleDb:7,bypassed:true}})){
      input.scene.layers[0]!.equalizer=equalizer;input.scene.masterEqualizer=equalizer;
      const outputPath=join(input.root,name+'.wav');await renderWav({...input,outputPath,durationSeconds:.2});
      expect(await readFile(outputPath)).toEqual(original);
    }
  });
  it('limits unclipped mixed peaks with linked channels and preserves the finite ending and source bytes',async()=>{
    const input=await fixture();input.scene.layers=Array.from({length:32},(_,index)=>fixtureLayer({id:String(index),assetId:input.record.id,gain:1,pan:0}));
    input.scene.outputLimiter={enabled:true,ceilingDb:-6};
    const result=await renderWav({...input,durationSeconds:.15});const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(result).toMatchObject({durationSeconds:.15,sampleRate:48000,channels:2,clippedSamples:0});
    expect(output.frames).toBe(7200);expect(result.peak).toBeCloseTo(.5011872336,4);
    for(let frame=1200;frame<3500;frame+=13){
      expect(output.channelData[0]![frame]).toBeCloseTo(.5011872336,4);
      expect(output.channelData[1]![frame]).toBeCloseTo(-.2505936168,4);
    }
    for(const samples of output.channelData)expect(samplePeak(samples,4800)).toBe(0);
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
    expect((await readdir(input.root)).sort()).toEqual(['finished.wav','source.wav']);
  });
  it('keeps disabled limiting byte-identical and enabled quiet audio unchanged within PCM16 rounding',async()=>{
    const input=await fixture({varying:true});await renderWav({...input,durationSeconds:.15});const original=await readFile(input.outputPath);
    input.scene.outputLimiter={enabled:false,ceilingDb:-12};
    const disabledPath=join(input.root,'disabled.wav');await renderWav({...input,outputPath:disabledPath,durationSeconds:.15});
    expect(await readFile(disabledPath)).toEqual(original);
    input.scene.outputLimiter={enabled:true,ceilingDb:-1};
    const enabledPath=join(input.root,'quiet.wav');await renderWav({...input,outputPath:enabledPath,durationSeconds:.15});
    const before=decodePcm16Wav(original);const after=decodePcm16Wav(await readFile(enabledPath));
    expect(after.frames).toBe(before.frames);
    for(let channel=0;channel<2;channel++)for(let frame=0;frame<after.frames;frame++)expect(Math.abs(after.channelData[channel]![frame]!-before.channelData[channel]![frame]!)).toBeLessThanOrEqual(1/32768);
  });
  it('retains layer and master filter tails after a delayed play-once source has faded out',async()=>{
    const input=await fixture({channels:1,frames:2400});input.scene.layers[0]!.startSeconds=.025;
    const settings={bassDb:12,midDb:0,trebleDb:0,bypassed:false};
    for(const stage of ['layer','master'] as const){
      delete input.scene.layers[0]!.equalizer;delete input.scene.masterEqualizer;
      if(stage==='layer')input.scene.layers[0]!.equalizer=settings;else input.scene.masterEqualizer=settings;
      const outputPath=join(input.root,stage+'-tail.wav');await renderWav({...input,outputPath,durationSeconds:.15});
      const output=decodePcm16Wav(await readFile(outputPath));
      for(const channel of output.channelData){
        expect(samplePeak(channel,0,1200)).toBe(0);
        expect(samplePeak(channel,3600,3840)).toBeGreaterThan(2/32768);
        expect(samplePeak(channel,5760)).toBeLessThanOrEqual(1/32768);
      }
    }
  });
  it('rejects changed source bytes, decoded/loop budget excess, invalid duration and occupied outputs',async()=>{
    const changed=await fixture();changed.assets[0]!.record.sha256='a'.repeat(64);
    await expect(renderWav({...changed,durationSeconds:.1})).rejects.toThrow('integrity');
    const bounded=await fixture();await expect(renderWav({...bounded,durationSeconds:.1,decodedBudgetBytes:1000})).rejects.toThrow('budget');
    bounded.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:.02};
    await expect(renderWav({...bounded,durationSeconds:.1,decodedBudgetBytes:40000})).rejects.toThrow('budget');
    bounded.scene.layers=Array.from({length:3},(_,index)=>({...bounded.scene.layers[0]!,id:String(index)}));
    await expect(renderWav({...bounded,durationSeconds:.1,decodedBudgetBytes:200000})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    for(const durationSeconds of [0,0.000001,Infinity,NaN,-1,25000])await expect(renderWav({...bounded,durationSeconds})).rejects.toThrow('duration');
    await writeFile(bounded.outputPath,'keep this file');await expect(renderWav({...bounded,durationSeconds:.1})).rejects.toThrow('already exists');
    expect(await readFile(bounded.outputPath,'utf8')).toBe('keep this file');
  });
  it.each([
    {name:'split intro/repeat',frames:10000,end:8400,crossfade:1200,budget:220000},
    {name:'direct repeat',frames:24000,end:24000,crossfade:0,budget:300000},
  ])('includes $name FIFO capacity in the export memory budget',async({frames,end,crossfade,budget})=>{
    const input=await fixture({frames,varying:true});
    input.scene.layers[0]!.loop={startSeconds:0,endSeconds:end/48000,crossfadeSeconds:crossfade/48000};
    await expect(renderWav({...input,durationSeconds:.4,decodedBudgetBytes:budget})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    const result=await renderWav({...input,durationSeconds:.4,decodedBudgetBytes:1024*1024});
    expect(result).toMatchObject({durationSeconds:.4,channels:2,clippedSamples:0});
  });
  it('cancels an owned FFmpeg render, waits for it to exit and removes only renderer temporary files',async()=>{
    const input=await fixture();input.scene.layers=[];
    await cancelSpawnedRender(input);
  });
  it('cancels the float-stream limiter render and includes its bounded buffers in the export budget',async()=>{
    const input=await fixture();input.scene.layers=[];input.scene.outputLimiter={enabled:true,ceilingDb:-1};
    await expect(renderWav({...input,durationSeconds:.1,decodedBudgetBytes:100000})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    await cancelSpawnedRender(input);
  });
  it('budgets and cancels the fade-only Float32 stream while preserving finite silence',async()=>{
    const input=await fixture();input.scene.layers=[];
    input.scene.listeningTimer={enabled:true,durationSeconds:1,fadeInSeconds:.025,fadeOutSeconds:.025};
    await expect(renderWav({...input,durationSeconds:.1,decodedBudgetBytes:100000})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    const result=await renderWav({...input,durationSeconds:.1,decodedBudgetBytes:250000,outputPath:join(input.root,'silent.wav')});
    expect(result).toMatchObject({durationSeconds:.1,peak:0,rms:0,clippedSamples:0});
    await cancelSpawnedRender(input);
  });
});

describe('captured transition native rendering',()=>{
  it('keeps equal layer identities and shared recordings as separate sides with independent master gain',async()=>{
    const input=await fixture();input.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:0};
    const scene=capturedTransition(input);scene.transition!.blend=.5;scene.transition!.b!.scene.masterGain=.5;
    await renderWav({...input,scene,durationSeconds:.25});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    for(const frame of [2400,4800,9600,11999]){
      expect(Math.abs(output.channelData[0]![frame]!*32768-900)).toBeLessThanOrEqual(1);
      expect(Math.abs(output.channelData[1]![frame]!*32768+450)).toBeLessThanOrEqual(1);
    }
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
    expect((await readdir(input.root)).sort()).toEqual(['finished.wav','source.wav']);
  });

  it('renders a saved hold and timed stereo transition and crops continuing sides without a new ending fade',async()=>{
    const input=await fixture({channels:1});input.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:0};
    const scene=capturedTransition(input),transition=scene.transition!;
    Object.assign(transition,{mode:'timed',blend:0,startSeconds:.1,durationSeconds:.1});
    transition.a!.scene.layers[0]!.pan=-1;transition.b!.scene.layers[0]!.pan=1;
    await renderWav({...input,scene,durationSeconds:.3});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    for(const [frame,blend] of [[2400,0],[4800,0],[6000,.25],[7200,.5],[8400,.75],[9600,1],[14399,1]] as const){
      expect(Math.abs(output.channelData[0]![frame]!*32768-1200*(1-blend))).toBeLessThanOrEqual(1);
      expect(Math.abs(output.channelData[1]![frame]!*32768-1200*blend)).toBeLessThanOrEqual(1);
    }
  });

  it('retains separate saved timer and legacy endpoints when the arrangement export is longer',async()=>{
    const input=await fixture({channels:1});input.scene.layers[0]!.loop={startSeconds:0,endSeconds:.1,crossfadeSeconds:0};
    const scene=capturedTransition(input),transition=scene.transition!;transition.blend=.5;
    const a=transition.a!.scene,b=transition.b!.scene;
    a.layers[0]!.pan=-1;b.layers[0]!.pan=1;
    a.listeningTimer={enabled:true,durationSeconds:.15,fadeInSeconds:0,fadeOutSeconds:.05};
    b.durationSeconds=.25;
    await renderWav({...input,scene,durationSeconds:.35});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    for(const [time,left,right] of [[.05,600,600],[.125,300,600],[.14,60,600],[.175,0,600],[.24,0,300],[.3,0,0]] as const){
      const frame=Math.round(time*48000);
      expect(Math.abs(output.channelData[0]![frame]!*32768-left)).toBeLessThanOrEqual(1);
      expect(Math.abs(output.channelData[1]![frame]!*32768-right)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps solo local to its captured side and does not add an ending fade to a cropped occasional event',async()=>{
    const input=await fixture({channels:1,frames:24000});
    input.scene.layers[0]!.occasional={enabled:true,minPauseSeconds:.25,maxPauseSeconds:.25,seed:1,alternateAssetIds:[],levelVariation:0,panVariation:0};
    const scene=capturedTransition(input),transition=scene.transition!;transition.blend=.5;
    transition.a!.scene.layers[0]!.pan=-1;transition.a!.scene.layers[0]!.solo=true;
    transition.b!.scene.layers[0]!.pan=1;
    await renderWav({...input,scene,durationSeconds:.2});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    // Occasional mono clips first use the event panner's equal-power center.
    const expected=1200*Math.SQRT2*.5;
    for(const frame of [2400,9599])for(const channel of output.channelData){
      expect(Math.abs(channel[frame]!*32768-expected)).toBeLessThanOrEqual(1);
    }
  });

  it('shares the temporary event allowance across both sides and removes partial preparation',async()=>{
    const input=await fixture({frames:8});
    input.scene.layers[0]!.occasional={enabled:true,minPauseSeconds:.25,maxPauseSeconds:.25,seed:1,alternateAssetIds:[],levelVariation:0,panVariation:0};
    const scene=capturedTransition(input);
    await expect(renderWav({...input,scene,durationSeconds:.7,occasionalSpoolBudgetBytes:250000})).rejects.toMatchObject({code:'EXPORT_STORAGE_BUDGET'});
    expect(await readdir(input.root)).toEqual(['source.wav']);
    expect(await readFile(input.assets[0]!.path)).toEqual(Buffer.from(input.bytes));
  });

  it('ends a timerless finite side and its EQ tail at its decoded natural deadline while the other side continues',async()=>{
    const input=await fixture({channels:1,frames:2400});
    // The actual decoded buffer, rather than approximate container duration, owns the end.
    input.record.durationSeconds=.2;
    const scene=capturedTransition(input),transition=scene.transition!;transition.blend=.5;
    const a=transition.a!.scene,b=transition.b!.scene;
    a.layers[0]!.startSeconds=.025;a.layers[0]!.pan=-1;
    a.layers[0]!.equalizer={bassDb:12,midDb:0,trebleDb:0,bypassed:false};
    a.masterEqualizer={bassDb:12,midDb:0,trebleDb:0,bypassed:false};
    b.layers[0]!.loop={startSeconds:0,endSeconds:.05,crossfadeSeconds:0};b.layers[0]!.pan=1;
    await renderWav({...input,scene,durationSeconds:.2});
    const output=decodePcm16Wav(await readFile(input.outputPath));
    expect(samplePeak(output.channelData[0]!,3400,3600)).toBeGreaterThan(2/32768);
    expect(samplePeak(output.channelData[0]!,3600)).toBe(0);
    for(const frame of [3600,4800,9599])expect(Math.abs(output.channelData[1]![frame]!*32768-600)).toBeLessThanOrEqual(1);
  });

  it('budgets and cancels the owned four-channel native stream before accepting any finished output',async()=>{
    const input=await fixture();input.scene.layers=[];input.scene=capturedTransition(input);
    await expect(renderWav({...input,durationSeconds:1,decodedBudgetBytes:300000})).rejects.toMatchObject({code:'EXPORT_BUDGET_EXCEEDED'});
    await cancelSpawnedRender(input);
  });
});
