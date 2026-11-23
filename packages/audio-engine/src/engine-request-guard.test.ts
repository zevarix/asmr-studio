import {afterEach,describe,expect,it} from 'vitest';
import {createEmptyTransition,parseCapturedMix,parseScene,type CapturedMix} from '@asmr-studio/contracts';
import {createMixer} from './engine.js';
import type {Mixer,MixerOptions,MixerOutputStage,PlaybackSnapshot} from './types.js';
import {FakeContext,FakeNode,FakeParam,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureAsset,fixtureLayer,fixtureScene} from '../../../tests/fixtures/scene.js';

const cancelled='The playback request is no longer current';
const mixers:Mixer[]=[];
function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(yes=>{resolve=yes;});
  return {promise,resolve};
}
function setup(context=new FakeContext(),options:Partial<Omit<MixerOptions,'context'>>={}){
  const mixer=createMixer({context:context as unknown as AudioContext,decodedBudgetBytes:16_000_000,
    loadAsset:async()=>fakeBuffer(2,480000),scheduleTick:()=>()=>{},...options});
  mixers.push(mixer);let snapshot!:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});
  return {context,mixer,observe(){mixer.subscribe(()=>{})();return snapshot;}};
}
function ordinary(){return {...fixtureScene(),layers:[fixtureLayer()]};}
class Stage {
  node=new FakeNode();listeningGain=new FakeParam();disposed=false;
  setLimiter(){}subscribe(){return()=>{};}reset(){}resetPeaks(){}
  dispose(){this.disposed=true;this.node.disconnect();}
}
function capture(id:string):CapturedMix {
  return parseCapturedMix({id:'capture-'+id,scene:{...ordinary(),id,outputLimiter:{enabled:true,ceilingDb:-1},
    layers:[fixtureLayer({assetId:id})]},assets:[{...fixtureAsset(),id,durationSeconds:10}]});
}
function arrangement(a:CapturedMix,b:CapturedMix|null=null){
  const initial=createEmptyTransition('arrangement','Crossfade');
  return parseScene({...initial,transition:{...initial.transition!,a,b,blend:.5}});
}
afterEach(()=>mixers.splice(0).forEach(mixer=>mixer.dispose()));

describe('playback request validity',()=>{
  it('rejects an initially invalid request without changing a playing mix or starting a load',async()=>{
    const loads:string[]=[];
    const {mixer,context,observe}=setup(undefined,{loadAsset:async id=>{loads.push(id);return fakeBuffer(2,480000);}});
    const base=ordinary();await mixer.setScene(base);await mixer.play();context.currentTime=1;
    const before=observe(),sources=[...context.sources],nodes=[...context.nodes],stops=sources.map(source=>[...source.stops]);
    const changed={...base,layers:[fixtureLayer({assetId:'other'})]};
    await expect(mixer.setScene(changed,()=>false)).rejects.toThrow(cancelled);
    await expect(mixer.updateScene(changed,()=>false)).rejects.toThrow(cancelled);
    await expect(mixer.play(()=>false)).rejects.toThrow(cancelled);
    expect(observe()).toEqual(before);expect(context.sources).toEqual(sources);expect(context.nodes).toEqual(nodes);
    expect(sources.map(source=>source.stops)).toEqual(stops);expect(loads).toEqual(['asset-rain']);
  });

  it('cancels a pending addition while retaining the playing source and newer local controls',async()=>{
    const audio=deferred<AudioBuffer>(),started=deferred<void>();let current=true;
    const {mixer,context,observe}=setup(undefined,{loadAsset:async id=>{
      if(id==='brush'){started.resolve();return audio.promise;}return fakeBuffer(2,480000);
    }});
    const base=ordinary();await mixer.setScene(base);await mixer.play();context.currentTime=1;
    const source=context.sources[0]!,stops=[...source.stops];
    const next={...base,layers:[...base.layers,fixtureLayer({id:'brush',assetId:'brush'})]};
    const pending=mixer.updateScene(next,()=>current);await started.promise;
    mixer.apply({type:'setLayerGain',layerId:'ambience',gain:.2});current=false;
    audio.resolve(fakeBuffer(2,480000));await expect(pending).rejects.toThrow(cancelled);
    expect(observe()).toMatchObject({state:'playing',positionSeconds:1,loadedAssetIds:['asset-rain'],error:cancelled});
    expect(context.sources).toEqual([source]);expect(source.stops).toEqual(stops);expect(source.starts).toHaveLength(1);
    const originalGain=context.gains.find(node=>node.targets.has(context.panners[0]))!;
    expect(originalGain.gain.value).toBe(.2);
    mixer.apply({type:'setMasterGain',gain:.4});
    expect(observe().loadedAssetIds).toEqual(['asset-rain']);
    await mixer.updateScene({...next,masterGain:.4,layers:[{...next.layers[0]!,gain:.2},next.layers[1]!]},()=>true);
    expect(observe()).toMatchObject({state:'playing',loadedAssetIds:['asset-rain','brush'],error:null});
    expect(context.sources).toHaveLength(2);expect(source.stops).toEqual(stops);expect(originalGain.gain.value).toBe(.2);
  });

  it('never commits a cancelled scene load and permits a later valid scene',async()=>{
    const audio=deferred<AudioBuffer>(),started=deferred<void>();let current=true;
    const {mixer,context,observe}=setup(undefined,{loadAsset:async id=>{
      if(id==='slow'){started.resolve();return audio.promise;}return fakeBuffer(2,480000);
    }});
    const pending=mixer.setScene({...ordinary(),layers:[fixtureLayer({assetId:'slow'})]},()=>current);
    await started.promise;current=false;audio.resolve(fakeBuffer(2,480000));
    await expect(pending).rejects.toThrow(cancelled);
    expect(observe()).toMatchObject({state:'error',loadedAssetIds:[],error:cancelled});
    expect(context.sources).toHaveLength(0);expect(context.panners).toHaveLength(0);
    await expect(mixer.play()).rejects.toThrow('Load a valid scene');
    await mixer.setScene(ordinary(),()=>true);await mixer.play(()=>true);
    expect(observe()).toMatchObject({state:'playing',loadedAssetIds:['asset-rain'],error:null});
    expect(context.sources).toHaveLength(1);
  });

  it('checks a scene request again after preparing the shared output stage',async()=>{
    const stage=deferred<MixerOutputStage>(),started=deferred<void>();let current=true,loads=0;
    const {mixer,context,observe}=setup(undefined,{createOutputStage:async()=>{started.resolve();return stage.promise;},
      loadAsset:async()=>{loads++;return fakeBuffer();}});
    const pending=mixer.setScene(ordinary(),()=>current);await started.promise;current=false;
    stage.resolve(new Stage() as unknown as MixerOutputStage);await expect(pending).rejects.toThrow(cancelled);
    expect(loads).toBe(0);expect(context.sources).toHaveLength(0);expect(context.panners).toHaveLength(0);
    expect(observe()).toMatchObject({state:'error',loadedAssetIds:[],error:cancelled});
  });

  it('disposes a cancelled captured-side processor without changing accepted playback',async()=>{
    const delayed=deferred<MixerOutputStage>(),started=deferred<void>();const stages:Stage[]=[];let current=true;
    const {mixer,context,observe}=setup(undefined,{createOutputStage:async()=>{
      const stage=new Stage();stages.push(stage);
      if(stages.length===3){started.resolve();return delayed.promise;}return stage as unknown as MixerOutputStage;
    }});
    const a=capture('a'),b=capture('b');await mixer.setScene(arrangement(a));await mixer.play();context.currentTime=1;
    const source=context.sources[0]!,stops=[...source.stops];
    const pending=mixer.updateScene(arrangement(a,b),()=>current);await started.promise;current=false;
    delayed.resolve(stages[2] as unknown as MixerOutputStage);await expect(pending).rejects.toThrow(cancelled);
    expect(stages[2]!.disposed).toBe(true);expect(stages.slice(0,2).every(stage=>!stage.disposed)).toBe(true);
    expect(observe()).toMatchObject({state:'playing',positionSeconds:1,loadedAssetIds:['a'],error:cancelled});
    expect(context.sources).toEqual([source]);expect(source.stops).toEqual(stops);
    await mixer.updateScene(arrangement(a,b),()=>true);
    expect(observe()).toMatchObject({state:'playing',loadedAssetIds:['a','b'],error:null});expect(context.sources).toHaveLength(2);
  });

  it('cleans all newly prepared sides when a scene request is revoked during processor loading',async()=>{
    const delayed=deferred<MixerOutputStage>(),started=deferred<void>();const stages:Stage[]=[];let current=true;
    const {mixer,context,observe}=setup(undefined,{createOutputStage:async()=>{
      const stage=new Stage();stages.push(stage);
      if(stages.length===3){started.resolve();return delayed.promise;}return stage as unknown as MixerOutputStage;
    }});
    const pending=mixer.setScene(arrangement(capture('a'),capture('b')),()=>current);await started.promise;current=false;
    delayed.resolve(stages[2] as unknown as MixerOutputStage);await expect(pending).rejects.toThrow(cancelled);
    expect(stages[0]!.disposed).toBe(false);expect(stages.slice(1).every(stage=>stage.disposed)).toBe(true);
    expect(context.sources).toHaveLength(0);expect(context.panners).toHaveLength(0);
    expect(observe()).toMatchObject({state:'error',loadedAssetIds:[],error:cancelled});
  });

  it('does not start playback if the request expires while the audio context resumes',async()=>{
    const context=new FakeContext(),resumed=deferred<void>();context.state='suspended';
    context.resume=async()=>{await resumed.promise;context.state='running';};let current=true;
    const {mixer,observe}=setup(context);await mixer.setScene(ordinary());
    const pending=mixer.play(()=>current);current=false;resumed.resolve();
    await expect(pending).rejects.toThrow(cancelled);
    expect(context.sources).toHaveLength(0);expect(observe().state).toBe('ready');
    await mixer.play(()=>true);expect(context.sources).toHaveLength(1);expect(observe().state).toBe('playing');
  });

  it('does not cancel an unrelated pending play when another request is already invalid',async()=>{
    const context=new FakeContext(),resumed=deferred<void>();context.state='suspended';
    context.resume=async()=>{await resumed.promise;context.state='running';};
    const {mixer,observe}=setup(context);await mixer.setScene(ordinary());const pending=mixer.play();
    const invalid=mixer.play(()=>false);resumed.resolve();
    await expect(invalid).rejects.toThrow(cancelled);
    await pending;expect(context.sources).toHaveLength(1);expect(observe().state).toBe('playing');
  });

  it('lets a newer scene edit win without an obsolete cancellation overwriting its result',async()=>{
    const audio=deferred<AudioBuffer>(),started=deferred<void>();let current=true;
    const {mixer,context,observe}=setup(undefined,{loadAsset:async id=>{
      if(id==='slow'){started.resolve();return audio.promise;}return fakeBuffer(2,480000);
    }});
    const base=ordinary();await mixer.setScene(base);await mixer.play();
    const pending=mixer.updateScene({...base,layers:[...base.layers,fixtureLayer({id:'slow',assetId:'slow'})]},()=>current);
    await started.promise;current=false;await mixer.updateScene({...base,masterGain:.4});
    audio.resolve(fakeBuffer(2,480000));await pending;
    expect(observe()).toMatchObject({state:'playing',loadedAssetIds:['asset-rain'],error:null});
    expect(context.sources).toHaveLength(1);expect(context.gains[0]!.gain.value).toBe(.4);
  });
});
