import {afterEach,describe,expect,it} from 'vitest';
import {createMixer} from './engine.js';
import type {Mixer,PlaybackSnapshot} from './types.js';
import {FakeContext,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureScene,fixtureLayer} from '../../../tests/fixtures/scene.js';
const mixers:Mixer[]=[];
function create(context=new FakeContext(),loadAsset=async(_id:string)=>fakeBuffer(),budget=10_000_000){const mixer=createMixer({context:context as unknown as AudioContext,loadAsset,decodedBudgetBytes:budget});mixers.push(mixer);let snapshot:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});return{context,mixer,snapshot:()=>snapshot!};}
afterEach(()=>mixers.splice(0).forEach(m=>m.dispose()));

describe('audio transport and immutable controls',()=>{
  it('borrows loaded or in-flight originals without starting another load or retaining disposed audio',async()=>{
    let release!:(buffer:AudioBuffer)=>void,started!:()=>void;
    const loading=new Promise<AudioBuffer>(resolve=>{release=resolve;});
    const requested=new Promise<void>(resolve=>{started=resolve;});
    const calls:string[]=[];
    const {mixer}=create(undefined,id=>{calls.push(id);started();return loading;});
    expect(mixer.getDecodedAsset('asset-rain')).toBeUndefined();
    expect(calls).toEqual([]);
    const pending=mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});
    await requested;
    const borrowed=mixer.getDecodedAsset('asset-rain');
    expect(borrowed).toBeInstanceOf(Promise);
    const buffer=fakeBuffer();release(buffer);
    expect(await borrowed).toBe(buffer);
    await pending;
    expect(mixer.getDecodedAsset('asset-rain')).toBe(buffer);
    expect(mixer.getDecodedAsset('missing')).toBeUndefined();
    expect(calls).toEqual(['asset-rain']);
    mixer.dispose();
    expect(mixer.getDecodedAsset('asset-rain')).toBeUndefined();
  });
  it('loads each referenced asset once and prevents duplicate starts',async()=>{
    const calls:string[]=[];const {context,mixer,snapshot}=create(undefined,async id=>{calls.push(id);return fakeBuffer();});
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer(),{...fixtureLayer(),id:'second'}]});
    expect(calls).toEqual(['asset-rain']);expect(snapshot().state).toBe('ready');
    await Promise.all([mixer.play(),mixer.play()]);await mixer.play();expect(context.sources).toHaveLength(2);
    expect(snapshot().state).toBe('playing');
  });
  it('ramps gain over 0.02 seconds without destroying mute solo settings',async()=>{
    const {context,mixer}=create();await mixer.setScene(fixtureScene());const controls=[...context.gains];await mixer.play();context.currentTime=2;
    mixer.apply({type:'setLayerGain',layerId:'narration',gain:0.7});
    expect(controls.some(g=>g.gain.ramps.some(([value,time])=>value===0.7&&time===2.02))).toBe(true);
    mixer.apply({type:'setMuted',layerId:'narration',muted:true});
    mixer.apply({type:'setMuted',layerId:'narration',muted:false});
    expect(controls.some(g=>g.gain.value===0.7)).toBe(true);
    mixer.apply({type:'setSolo',layerId:'narration',solo:true});
    expect(controls.filter(g=>g.gain.value===0)).toHaveLength(1);
    mixer.apply({type:'setSolo',layerId:'narration',solo:false});
    expect(controls.some(g=>g.gain.value===0.5)).toBe(true);
  });
  it('pause and resume preserve time and planned layer offsets',async()=>{
    const {context,mixer,snapshot}=create(undefined,async()=>fakeBuffer(2,480000));
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer(),{...fixtureLayer(),id:'later',startSeconds:3}]});
    await mixer.play();context.currentTime=2;mixer.pause();expect(snapshot().state).toBe('paused');expect(snapshot().positionSeconds).toBe(2);
    context.currentTime=4;await mixer.play();expect(context.sources[2]?.starts[0]).toEqual([4,2,undefined]);expect(context.sources[3]?.starts[0]).toEqual([5,0,undefined]);
    context.currentTime=5;mixer.pause();expect(snapshot().positionSeconds).toBe(3);
  });
  it('interruption is not reported as playing and dispose releases owned resources',async()=>{
    const {context,mixer,snapshot}=create();await mixer.setScene(fixtureScene());await mixer.play();context.currentTime=0.2;context.interrupt();
    expect(snapshot().state).toBe('interrupted');expect(snapshot().positionSeconds).toBeCloseTo(0.2);
    mixer.dispose();expect(context.nodes.every(node=>node.disconnected)).toBe(true);expect(context.sources.every(source=>source.buffer===null)).toBe(true);
    expect(snapshot().loadedAssetIds).toEqual([]);await expect(mixer.play()).rejects.toThrow();
  });
  it('rejects actual decoded-memory excess and invalid loop endpoints',async()=>{
    const {mixer,snapshot}=create(undefined,async()=>fakeBuffer(),100);
    await expect(mixer.setScene(fixtureScene())).rejects.toThrow();expect(snapshot().state).toBe('error');expect(snapshot().loadedAssetIds).toEqual([]);
    const other=create();await expect(other.mixer.setScene({...fixtureScene(),layers:[{...fixtureLayer(),loop:{startSeconds:0,endSeconds:2,crossfadeSeconds:0}}]})).rejects.toThrow();
  });
  it('ignores a late asset result from a superseded load',async()=>{
    let release!:(buffer:AudioBuffer)=>void;const late=new Promise<AudioBuffer>(resolve=>{release=resolve;});
    const {mixer,snapshot}=create(undefined,id=>id==='slow'?late:Promise.resolve(fakeBuffer()));
    const slow=mixer.setScene({...fixtureScene(),layers:[{...fixtureLayer(),assetId:'slow'}]});
    await mixer.setScene({...fixtureScene(),layers:[{...fixtureLayer(),assetId:'fast'}]});release(fakeBuffer());await slow;
    expect(snapshot().state).toBe('ready');expect(snapshot().loadedAssetIds).toEqual(['fast']);
  });
  it('stop rewinds and a pending resume cannot resurrect disposed playback',async()=>{
    const context=new FakeContext();let release!:()=>void;context.state='suspended';context.resume=()=>new Promise<void>(resolve=>{release=resolve;});
    const {mixer,snapshot}=create(context);await mixer.setScene(fixtureScene());const pending=mixer.play();mixer.dispose();release();await pending;
    expect(context.sources).toHaveLength(0);expect(snapshot().state).toBe('idle');
    const other=create();await other.mixer.setScene(fixtureScene());await other.mixer.play();other.context.currentTime=0.3;other.mixer.stop();expect(other.snapshot().positionSeconds).toBe(0);expect(other.snapshot().state).toBe('ready');
  });
});

describe('structural edits and derived-loop allocation',()=>{
  it('removes one source without restarting a retained layer and rejects unloaded additions',async()=>{
    const {context,mixer,snapshot}=create();await mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});await mixer.play();
    mixer.apply({type:'addLayer',layer:{...fixtureLayer(),id:'second'}});expect(context.sources).toHaveLength(2);
    mixer.apply({type:'removeLayer',layerId:'ambience'});expect(context.sources[0]?.buffer).toBeNull();expect(context.sources[1]?.buffer).not.toBeNull();
    expect(()=>mixer.apply({type:'addLayer',layer:{...fixtureLayer(),id:'unloaded',assetId:'not-loaded'}})).toThrow();
    expect(snapshot().loadedAssetIds).toEqual(['asset-rain']);expect(context.sources).toHaveLength(2);
  });
  it('counts derived crossfade memory against the same budget as decoded assets',async()=>{
    const {mixer,snapshot}=create(undefined,async()=>fakeBuffer(),400000);
    await expect(mixer.setScene({...fixtureScene(),layers:[{...fixtureLayer(),loop:{startSeconds:0,endSeconds:1,crossfadeSeconds:0.2}}]})).rejects.toThrow();
    expect(snapshot().state).toBe('error');expect(snapshot().loadedAssetIds).toEqual([]);
  });
  it('reuses loop buffers still held by a removed layer instead of exceeding the budget',async()=>{
    const {context,mixer}=create(undefined,async()=>fakeBuffer(),691200);
    const loop={...fixtureLayer(),id:'loop',loop:{startSeconds:0,endSeconds:1,crossfadeSeconds:0.2}};
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer(),loop]});await mixer.play();context.currentTime=0.25;
    for(let i=0;i<3;i++){mixer.apply({type:'removeLayer',layerId:'loop'});mixer.apply({type:'addLayer',layer:loop});}
    expect(context.createdBuffers).toHaveLength(1);
    expect(new Set(context.sources.filter(source=>source.loop&&source.buffer).map(source=>source.buffer)).size).toBe(1);
  });
  it('counts retiring buffers before allocating a different loop, then frees their budget on end',async()=>{
    const {context,mixer}=create(undefined,async()=>fakeBuffer(),691200);
    const loop={...fixtureLayer(),id:'loop',loop:{startSeconds:0,endSeconds:1,crossfadeSeconds:0.2}};
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer(),loop]});await mixer.play();context.currentTime=0.25;
    const retiring=context.sources.slice(1);mixer.apply({type:'removeLayer',layerId:'loop'});
    const different={...loop,loop:{...loop.loop,endSeconds:0.9}};
    expect(()=>mixer.apply({type:'addLayer',layer:different})).toThrow(/budget/);
    expect(context.createdBuffers).toHaveLength(1);
    for(const source of retiring)source.onended?.();context.currentTime=0.28;
    expect(()=>mixer.apply({type:'addLayer',layer:different})).not.toThrow();expect(context.createdBuffers).toHaveLength(2);
  });
});

describe('live scene reconciliation',()=>{
  it('loads an added sound without restarting retained playback or resetting its clock',async()=>{
    let release!:(buffer:AudioBuffer)=>void;const late=new Promise<AudioBuffer>(resolve=>{release=resolve;});
    const calls:string[]=[];
    const {context,mixer,snapshot}=create(undefined,id=>{calls.push(id);return id==='brush'?late:Promise.resolve(fakeBuffer(2,480000));});
    const base={...fixtureScene(),layers:[fixtureLayer()]};
    await mixer.setScene(base);await mixer.play();context.currentTime=2;
    const retained=context.sources[0]!;
    const next={...base,layers:[...base.layers,{...fixtureLayer(),id:'brush',assetId:'brush',loop:{startSeconds:0,endSeconds:4,crossfadeSeconds:0}}]};
    const pending=mixer.updateScene(next);
    expect(snapshot().state).toBe('playing');expect(retained.stops).toEqual([10]);
    context.currentTime=3;release(fakeBuffer(2,480000));await pending;
    expect(calls).toEqual(['asset-rain','brush']);expect(retained.starts).toHaveLength(1);expect(retained.stops).toEqual([10]);
    expect(snapshot().positionSeconds).toBe(3);expect(snapshot().state).toBe('playing');
    expect(context.sources[1]?.starts[0]).toEqual([3,3,undefined]);
  });
  it('shares in-flight decoding while the latest scene wins and synchronous controls stay current',async()=>{
    let release!:(buffer:AudioBuffer)=>void;const late=new Promise<AudioBuffer>(resolve=>{release=resolve;});
    let loads=0;
    const {context,mixer,snapshot}=create(undefined,id=>id==='brush'?(loads++,late):Promise.resolve(fakeBuffer(2,480000)));
    const base={...fixtureScene(),layers:[fixtureLayer()]};await mixer.setScene(base);await mixer.play();context.currentTime=1;
    const extra={...fixtureLayer(),id:'brush',assetId:'brush'};
    const first=mixer.updateScene({...base,layers:[...base.layers,extra]});
    const latest=mixer.updateScene({...base,masterGain:0.4,layers:[...base.layers,{...extra,pan:0.6}]});
    mixer.apply({type:'setLayerGain',layerId:'ambience',gain:0.2});
    mixer.apply({type:'setMuted',layerId:'brush',muted:true});
    release(fakeBuffer(2,480000));await Promise.all([first,latest]);
    expect(loads).toBe(1);expect(context.sources).toHaveLength(2);expect(snapshot().positionSeconds).toBe(1);
    expect(context.gains[0]?.gain.value).toBe(0.4);
    expect(context.gains[1]?.gain.value).toBe(0.2);
    expect(context.gains[3]?.gain.value).toBe(0);
  });
  it('does not resurrect a sound removed while its asset was decoding',async()=>{
    let release!:(buffer:AudioBuffer)=>void;const late=new Promise<AudioBuffer>(resolve=>{release=resolve;});
    const {context,mixer,snapshot}=create(undefined,id=>id==='brush'?late:Promise.resolve(fakeBuffer(2,480000)));
    const base={...fixtureScene(),layers:[fixtureLayer()]};await mixer.setScene(base);await mixer.play();context.currentTime=1;
    const pending=mixer.updateScene({...base,layers:[...base.layers,{...fixtureLayer(),id:'brush',assetId:'brush'}]});
    mixer.apply({type:'removeLayer',layerId:'brush'});
    release(fakeBuffer(2,480000));await pending;
    expect(context.sources).toHaveLength(1);expect(context.sources[0]?.starts).toHaveLength(1);
    expect(snapshot().loadedAssetIds).toEqual(['asset-rain']);expect(snapshot().positionSeconds).toBe(1);
  });
  it('never auto-resumes after stop, pause, or interruption during a pending addition',async()=>{
    for(const action of ['stop','pause','interrupt'] as const){
      let release!:(buffer:AudioBuffer)=>void;const late=new Promise<AudioBuffer>(resolve=>{release=resolve;});
      const {context,mixer,snapshot}=create(undefined,id=>id==='brush'?late:Promise.resolve(fakeBuffer(2,480000)));
      const base={...fixtureScene(),layers:[fixtureLayer()]};await mixer.setScene(base);await mixer.play();context.currentTime=1;
      const pending=mixer.updateScene({...base,layers:[...base.layers,{...fixtureLayer(),id:'brush',assetId:'brush'}]});
      if(action==='interrupt')context.interrupt();else mixer[action]();
      release(fakeBuffer(2,480000));await pending;
      expect(context.sources).toHaveLength(1);
      expect(snapshot().state).toBe(action==='stop'?'ready':action==='pause'?'paused':'interrupted');
      expect(snapshot().positionSeconds).toBe(action==='stop'?0:1);
      expect(snapshot().loadedAssetIds).toEqual(['asset-rain','brush']);
      await mixer.play();expect(context.sources).toHaveLength(3);
    }
  });
  it('keeps playable audio on a failed addition and permits an explicit retry',async()=>{
    let fail=true;
    const {context,mixer,snapshot}=create(undefined,async id=>{if(id==='brush'&&fail)throw new Error('unavailable');return fakeBuffer(2,480000);});
    const base={...fixtureScene(),layers:[fixtureLayer()]};await mixer.setScene(base);await mixer.play();context.currentTime=2;
    const next={...base,layers:[...base.layers,{...fixtureLayer(),id:'brush',assetId:'brush'}]};
    await expect(mixer.updateScene(next)).rejects.toThrow('unavailable');
    expect(snapshot().state).toBe('playing');expect(snapshot().error).toBe('The new sound could not be loaded');
    expect(snapshot().loadedAssetIds).toEqual(['asset-rain']);expect(context.sources).toHaveLength(1);expect(context.sources[0]?.stops).toEqual([10]);
    fail=false;await mixer.updateScene(next);
    expect(snapshot().error).toBeNull();expect(snapshot().positionSeconds).toBe(2);expect(context.sources).toHaveLength(2);
  });
  it('a scene switch cancels an outstanding edit without contaminating the new scene',async()=>{
    let release!:(buffer:AudioBuffer)=>void;const late=new Promise<AudioBuffer>(resolve=>{release=resolve;});
    const {context,mixer,snapshot}=create(undefined,id=>id==='brush'?late:Promise.resolve(fakeBuffer(2,480000)));
    const base={...fixtureScene(),layers:[fixtureLayer()]};await mixer.setScene(base);await mixer.play();
    const pending=mixer.updateScene({...base,layers:[...base.layers,{...fixtureLayer(),id:'brush',assetId:'brush'}]});
    await mixer.setScene({...base,id:'different',layers:[{...fixtureLayer(),assetId:'different'}]});
    release(fakeBuffer(2,480000));await pending;
    expect(snapshot().state).toBe('ready');expect(snapshot().loadedAssetIds).toEqual(['different']);
    expect(context.sources).toHaveLength(1);expect(context.sources[0]?.buffer).toBeNull();
  });
  it('crossfades only the edited loop and rejects out-of-bounds edits before audible changes',async()=>{
    const {context,mixer,snapshot}=create(undefined,async()=>fakeBuffer(2,480000));
    const base={...fixtureScene(),layers:[{...fixtureLayer(),loop:{startSeconds:0,endSeconds:2,crossfadeSeconds:0}}, {...fixtureLayer(),id:'retained'}]};
    await mixer.setScene(base);const controls=context.gains.length;await mixer.play();context.currentTime=0.5;
    const original=context.sources[0]!,retained=context.sources[1]!;
    expect(()=>mixer.apply({type:'setLayerLoop',layerId:'ambience',loop:{startSeconds:0,endSeconds:11,crossfadeSeconds:0}})).toThrow(/boundaries/);
    expect(original.stops).toEqual([]);expect(context.sources).toHaveLength(2);
    mixer.apply({type:'setLayerLoop',layerId:'ambience',loop:{startSeconds:0.2,endSeconds:3,crossfadeSeconds:0.1}});
    expect(original.stops.at(-1)).toBeCloseTo(0.52);expect(retained.stops).toEqual([10]);expect(retained.starts).toHaveLength(1);
    expect(snapshot().positionSeconds).toBe(0.5);expect(context.sources).toHaveLength(3);
    for(const time of [0.5,0.505,0.51,0.52]){
      const level=context.gains[controls]!.gain.valueAt(time)+context.gains[controls+2]!.gain.valueAt(time);
      expect(level).toBeCloseTo(1,8);
    }
    mixer.apply({type:'setLayerLoop',layerId:'ambience',loop:null});
    expect(context.sources.at(-1)?.loop).toBe(false);expect(retained.starts).toHaveLength(1);
  });
});

describe('playback transition lifetime',()=>{
  it('keeps the summed gain steady through repeated immediate pause/resume transitions',async()=>{
    const {context,mixer}=create();await mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});
    const controls=context.gains.length;await mixer.play();
    context.currentTime=0.08;mixer.pause();await mixer.play();
    context.currentTime=0.09;mixer.pause();await mixer.play();
    for(const time of [0.09,0.095,0.1,0.105,0.11,0.12]){
      const sum=context.gains.slice(controls).reduce((value,node)=>value+node.gain.valueAt(time),0);
      expect(sum).toBeCloseTo(1,8);
    }
  });
  it('pauses the timeline immediately but retains the source until its short release ends',async()=>{
    const {context,mixer,snapshot}=create();
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});await mixer.play();
    const source=context.sources[0]!;context.currentTime=0.25;mixer.pause();
    expect(snapshot().state).toBe('paused');expect(snapshot().positionSeconds).toBe(0.25);
    expect(source.stops.at(-1)).toBeCloseTo(0.27);expect(source.buffer).not.toBeNull();expect(source.disconnected).toBe(false);
    source.onended?.();expect(source.buffer).toBeNull();expect(source.disconnected).toBe(true);
  });
  it('does not extend a retiring tail when stop is repeated or stop a resumed source',async()=>{
    const {context,mixer,snapshot}=create();
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});await mixer.play();
    context.currentTime=0.25;mixer.pause();const old=context.sources[0]!;
    context.currentTime=0.255;mixer.stop();mixer.stop();await mixer.play();
    expect(old.stops.at(-1)).toBeCloseTo(0.27);expect(snapshot().positionSeconds).toBe(0);
    const resumed=context.sources[1]!;expect(resumed.starts[0]).toEqual([0.255,0,undefined]);
    old.onended?.();expect(old.buffer).toBeNull();expect(resumed.buffer).not.toBeNull();expect(resumed.disconnected).toBe(false);
  });
  it('cancels a delayed layer before it starts while letting the audible layer release',async()=>{
    const {context,mixer}=create();
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer(),{...fixtureLayer(),id:'later',startSeconds:0.5}]});
    await mixer.play();context.currentTime=0.25;mixer.stop();
    expect(context.sources[0]!.stops.at(-1)).toBeCloseTo(0.27);expect(context.sources[0]!.buffer).not.toBeNull();
    expect(context.sources[1]!.buffer).toBeNull();expect(context.sources[1]!.disconnected).toBe(true);
  });
  it('cleans up a paused tail on browser interruption without changing the paused timeline',async()=>{
    const {context,mixer,snapshot}=create();
    await mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});await mixer.play();
    context.currentTime=0.25;mixer.pause();expect(context.sources[0]!.buffer).not.toBeNull();
    context.interrupt();expect(snapshot().state).toBe('paused');expect(snapshot().positionSeconds).toBe(0.25);
    expect(context.sources[0]!.buffer).toBeNull();expect(context.sources[0]!.disconnected).toBe(true);
  });
  it('retains a removed layer only for its release, and disposal releases every tail',async()=>{
    const {context,mixer}=create();await mixer.setScene(fixtureScene());await mixer.play();context.currentTime=0.25;
    mixer.apply({type:'removeLayer',layerId:'ambience'});
    expect(context.sources[0]!.stops.at(-1)).toBeCloseTo(0.27);expect(context.sources[0]!.buffer).not.toBeNull();
    expect(context.sources[1]!.starts).toHaveLength(1);mixer.pause();mixer.dispose();
    expect(context.sources.every(source=>source.buffer===null)).toBe(true);expect(context.nodes.every(node=>node.disconnected)).toBe(true);
  });
});

it('rejects an oversized pending recording for both the borrower and the mixer',async()=>{
  let release!:(buffer:AudioBuffer)=>void,started!:()=>void;
  const loading=new Promise<AudioBuffer>(resolve=>{release=resolve;});
  const requested=new Promise<void>(resolve=>{started=resolve;});
  const calls:string[]=[];
  const {mixer}=create(undefined,id=>{calls.push(id);started();return loading;},127);
  expect(mixer.getDecodedAsset('missing')).toBeUndefined();
  expect(calls).toEqual([]);
  const scene=mixer.setScene({...fixtureScene(),layers:[fixtureLayer()]});
  await requested;
  const borrowed=mixer.getDecodedAsset('asset-rain');
  expect(borrowed).toBeInstanceOf(Promise);
  const checks=Promise.all([
    expect(borrowed).rejects.toThrow('Audio exceeds the decoded-memory budget'),
    expect(scene).rejects.toThrow('Audio exceeds the decoded-memory budget'),
  ]);
  release(fakeBuffer(2,16,48000));
  await checks;
  expect(mixer.getDecodedAsset('asset-rain')).toBeUndefined();
  expect(calls).toEqual(['asset-rain']);
});
