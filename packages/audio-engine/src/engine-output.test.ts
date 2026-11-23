import {afterEach,describe,expect,it} from 'vitest';
import type {OutputLimiterSettings} from '@asmr-studio/contracts';
import {createMixer} from './engine.js';
import {emptyOutputMeterSnapshot,type OutputMeterSnapshot} from './output-processor.js';
import type {Mixer,MixerOutputStage,PlaybackSnapshot} from './types.js';
import {FakeContext,FakeNode,FakeParam,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureLayer,fixtureScene} from '../../../tests/fixtures/scene.js';

class OutputStage {
  node=new FakeNode();settings:OutputLimiterSettings|undefined;disposed=false;resets=0;peaksReset=0;
  listeningGain=new FakeParam();
  listeners=new Set<(snapshot:OutputMeterSnapshot)=>void>();
  setLimiter(settings:OutputLimiterSettings|undefined){this.settings=settings;}
  subscribe(listener:(snapshot:OutputMeterSnapshot)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  emit(snapshot:OutputMeterSnapshot){for(const listener of this.listeners)listener(snapshot);}
  reset(){this.resets++;}
  resetPeaks(){this.peaksReset++;}
  dispose(){this.disposed=true;this.node.disconnect();this.listeners.clear();}
}
const mixers:Mixer[]=[];
function create(factory?:()=>Promise<OutputStage>){
  const context=new FakeContext();
  const mixer=createMixer({context:context as unknown as AudioContext,loadAsset:async()=>fakeBuffer(2,480000),decodedBudgetBytes:10000000,
    ...(factory?{createOutputStage:factory as unknown as ()=>Promise<MixerOutputStage>}:{})});
  mixers.push(mixer);let snapshot!:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});
  return {mixer,context,snapshot:()=>snapshot};
}
afterEach(()=>mixers.splice(0).forEach(mixer=>mixer.dispose()));
const limiter={enabled:true,ceilingDb:-1};

describe('master output stage lifecycle',()=>{
  it('keeps the original legacy route and explicitly rejects enabled limiting when no processor is supplied',async()=>{
    const {mixer,context,snapshot}=create();
    await mixer.setScene(fixtureScene());await mixer.play();context.currentTime=.5;
    const sources=[...context.sources];
    expect(()=>mixer.apply({type:'setOutputLimiter',limiter})).toThrow(/output processor/i);
    mixer.subscribe(()=>{});
    expect(context.sources).toEqual(sources);expect(snapshot()).toMatchObject({state:'playing',positionSeconds:.5});
    const other=create();await expect(other.mixer.setScene({...fixtureScene(),outputLimiter:limiter})).rejects.toThrow(/output processor/i);
    expect(other.snapshot().state).toBe('error');
  });

  it('waits for one stage, routes it after master gain, and edits its controls without restarting sources',async()=>{
    let resolve!:(stage:OutputStage)=>void;const pending=new Promise<OutputStage>(done=>{resolve=done;});
    const stage=new OutputStage();let calls=0;const {mixer,context,snapshot}=create(()=>{calls++;return pending;});
    const ready=mixer.setScene({...fixtureScene(),outputLimiter:limiter});
    expect(snapshot().state).toBe('loading');expect(context.sources).toHaveLength(0);
    resolve(stage);await ready;
    expect(stage.settings).toEqual(limiter);expect(context.gains[0]!.targets.has(stage.node)).toBe(true);
    const analyser=[...stage.node.targets][0] as FakeNode;expect(analyser.targets.has(context.destination)).toBe(true);
    await mixer.play();context.currentTime=1;const sources=[...context.sources];
    mixer.apply({type:'setOutputLimiter',limiter:{enabled:true,ceilingDb:-4}});
    expect(stage.settings).toEqual({enabled:true,ceilingDb:-4});expect(context.sources).toEqual(sources);
    expect(snapshot()).toMatchObject({state:'playing',positionSeconds:1});
    await mixer.setScene({...fixtureScene(),id:'other'});expect(calls).toBe(1);expect(stage.settings).toBeUndefined();
  });

  it('schedules the listening envelope on the output stage parameter without inserting another audio gain',async()=>{
    const stage=new OutputStage();const {mixer,context}=create(async()=>stage);
    await mixer.setScene({...fixtureScene(),listeningTimer:{enabled:true,durationSeconds:4,fadeInSeconds:1,fadeOutSeconds:1}});
    expect(context.gains[0]!.targets.has(stage.node)).toBe(true);
    expect(context.gains).toHaveLength(3);await mixer.play();
    expect(stage.listeningGain.valueAt(0)).toBe(0);expect(stage.listeningGain.valueAt(.5)).toBeCloseTo(.5,7);
    expect(stage.listeningGain.valueAt(3.5)).toBeCloseTo(.5,7);expect(stage.listeningGain.valueAt(4)).toBe(0);
  });

  it('keeps the newest scene when stage setup resolves after a superseding scene load',async()=>{
    let resolve!:(stage:OutputStage)=>void;const pending=new Promise<OutputStage>(done=>{resolve=done;});
    const stage=new OutputStage();let calls=0;const {mixer,snapshot}=create(()=>{calls++;return pending;});
    const first=mixer.setScene({...fixtureScene(),outputLimiter:limiter});
    const latest=mixer.setScene({...fixtureScene(),id:'latest',outputLimiter:{enabled:true,ceilingDb:-6},layers:[fixtureLayer({assetId:'new'})]});
    resolve(stage);await Promise.all([first,latest]);
    expect(calls).toBe(1);expect(stage.settings).toEqual({enabled:true,ceilingDb:-6});
    expect(snapshot()).toMatchObject({state:'ready',loadedAssetIds:['new']});
  });

  it('disposes a stage which resolves after mixer disposal without reconnecting audio',async()=>{
    let resolve!:(stage:OutputStage)=>void;const pending=new Promise<OutputStage>(done=>{resolve=done;});
    const stage=new OutputStage();const {mixer,context}=create(()=>pending);
    const ready=mixer.setScene(fixtureScene());mixer.dispose();resolve(stage);await ready;
    expect(stage.disposed).toBe(true);expect(stage.node.targets.size).toBe(0);
    expect(context.nodes.every(node=>node.disconnected)).toBe(true);
  });

  it('reports failed setup, then allows a fresh explicit scene load to retry',async()=>{
    const stage=new OutputStage();let calls=0;const {mixer,snapshot}=create(async()=>{if(++calls===1)throw new Error('module unavailable');return stage;});
    await expect(mixer.setScene(fixtureScene())).rejects.toThrow('module unavailable');
    expect(snapshot().state).toBe('error');await mixer.setScene(fixtureScene());expect(snapshot().state).toBe('ready');expect(calls).toBe(2);
  });

  it('emits isolated meter snapshots and resets peak holds without touching playback',async()=>{
    const stage=new OutputStage();const {mixer,context}=create(async()=>stage);const received:OutputMeterSnapshot[]=[];
    mixer.subscribeOutput(snapshot=>{snapshot.heldPeak[0]=99;});
    mixer.subscribeOutput(snapshot=>received.push(snapshot));
    await mixer.setScene(fixtureScene());await mixer.play();const sources=[...context.sources];
    const value={...emptyOutputMeterSnapshot(),available:true,heldPeak:[.2,.1] as [number,number]};stage.emit(value);
    expect(received.at(-1)?.heldPeak).toEqual([.2,.1]);expect(value.heldPeak).toEqual([.2,.1]);
    mixer.resetOutputPeaks();expect(stage.peaksReset).toBe(1);expect(context.sources).toEqual(sources);
    mixer.dispose();expect(received.at(-1)?.available).toBe(false);expect(stage.disposed).toBe(true);
  });

  it('stops audio and exposes a processing fault instead of bypassing the limiter',async()=>{
    const stage=new OutputStage();const {mixer,context,snapshot}=create(async()=>stage);
    await mixer.setScene({...fixtureScene(),outputLimiter:limiter});await mixer.play();
    stage.emit({...emptyOutputMeterSnapshot(),available:true,error:'Output processor failed.'});
    expect(snapshot()).toMatchObject({state:'error',error:'Output processor failed.'});
    expect(context.sources.every(source=>source.buffer===null)).toBe(true);
    await expect(mixer.play()).rejects.toThrow();
  });

  it('creates a fresh processor on explicit scene reload after a processing fault',async()=>{
    const first=new OutputStage(),second=new OutputStage();let calls=0;
    const {mixer,snapshot}=create(async()=>++calls===1?first:second);
    await mixer.setScene({...fixtureScene(),outputLimiter:limiter});await mixer.play();
    first.emit({...emptyOutputMeterSnapshot(),available:true,error:'Output processor failed.'});
    await mixer.setScene({...fixtureScene(),outputLimiter:limiter});
    expect(first.disposed).toBe(true);expect(calls).toBe(2);expect(snapshot().state).toBe('ready');
    await mixer.play();expect(snapshot().state).toBe('playing');expect(second.settings).toEqual(limiter);
  });

  it('does not let Stop clear a persistent output fault or restart sources before explicit scene reload',async()=>{
    const first=new OutputStage(),second=new OutputStage();let calls=0;
    const {mixer,context,snapshot}=create(async()=>++calls===1?first:second);
    await mixer.setScene({...fixtureScene(),outputLimiter:limiter});await mixer.play();
    first.emit({...emptyOutputMeterSnapshot(),available:false,error:'Output processor failed.'});
    const count=context.sources.length;mixer.stop();
    await expect(mixer.play()).rejects.toThrow();
    expect(context.sources).toHaveLength(count);expect(snapshot()).toMatchObject({state:'error',error:'Output processor failed.',positionSeconds:0});
    await mixer.setScene({...fixtureScene(),outputLimiter:limiter});await mixer.play();
    expect(snapshot().state).toBe('playing');expect(first.disposed).toBe(true);expect(calls).toBe(2);
  });

  it('rejects and disposes a factory stage whose initial subscription already reports a fault',async()=>{
    class FailedStage extends OutputStage {
      override subscribe(listener:(snapshot:OutputMeterSnapshot)=>void){
        const unsubscribe=super.subscribe(listener);
        listener({...emptyOutputMeterSnapshot(),error:'Output processor failed during creation.'});return unsubscribe;
      }
    }
    const stage=new FailedStage();const {mixer,snapshot}=create(async()=>stage);
    let output!:OutputMeterSnapshot;mixer.subscribeOutput(value=>{output=value;});
    await expect(mixer.setScene({...fixtureScene(),outputLimiter:limiter})).rejects.toThrow('Output processor failed during creation.');
    expect(stage.disposed).toBe(true);expect(snapshot().state).toBe('error');
    expect(output.error).toBe('Output processor failed during creation.');await expect(mixer.play()).rejects.toThrow();
  });
});
