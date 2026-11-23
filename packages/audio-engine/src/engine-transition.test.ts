import {afterEach,describe,expect,it} from 'vitest';
import {createEmptyTransition,parseCapturedMix,parseScene,type CapturedMix,type Layer,type MixTransition,type OutputLimiterSettings,type Scene} from '@asmr-studio/contracts';
import {createMixer} from './engine.js';
import {emptyOutputMeterSnapshot,type OutputMeterSnapshot} from './output-processor.js';
import type {Mixer,MixerOptions,MixerOutputStage,PlaybackSnapshot} from './types.js';
import {FakeContext,FakeNode,FakeParam,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureAsset,fixtureLayer,fixtureScene} from '../../../tests/fixtures/scene.js';

class Stage {
  node=new FakeNode();listeningGain=new FakeParam();settings:OutputLimiterSettings|undefined;
  disposed=false;listeners=new Set<(snapshot:OutputMeterSnapshot)=>void>();
  setLimiter(value:OutputLimiterSettings|undefined){this.settings=value;}
  subscribe(listener:(snapshot:OutputMeterSnapshot)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  emit(value:OutputMeterSnapshot){for(const listener of this.listeners)listener(value);}
  reset(){}resetPeaks(){}
  dispose(){this.disposed=true;this.listeners.clear();this.node.disconnect();}
}
const mixers:Mixer[]=[];
function setup(options:Partial<MixerOptions>={}){
  const context=new FakeContext();const stages:Stage[]=[];
  const mixer=createMixer({context:context as unknown as AudioContext,decodedBudgetBytes:16_000_000,
    loadAsset:async()=>fakeBuffer(2,480000),scheduleTick:()=>()=>{},
    createOutputStage:async()=>{const stage=new Stage();stages.push(stage);return stage as unknown as MixerOutputStage;},...options});
  mixers.push(mixer);let snapshot!:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});
  return {context,mixer,stages,observe(){mixer.subscribe(()=>{})();return snapshot;}};
}
function capture(id:string,overrides:Partial<Scene>={},layers:Layer[]=[fixtureLayer({assetId:id,gain:1,loop:{startSeconds:0,endSeconds:2,crossfadeSeconds:0}})]):CapturedMix {
  const source={...fixtureScene(),id,masterGain:1,outputLimiter:{enabled:true,ceilingDb:-1},layers,...overrides};
  const ids=[...new Set(source.layers.flatMap(layer=>[layer.assetId,...(layer.occasional?.alternateAssetIds??[])]))];
  return parseCapturedMix({id:'capture-'+id,scene:source,assets:ids.map(assetId=>({...fixtureAsset(),id:assetId,durationSeconds:10}))});
}
function arrangement(a:CapturedMix|null=capture('a'),b:CapturedMix|null=capture('b'),settings:Partial<MixTransition>={}):Scene {
  const initial=createEmptyTransition('arrangement','Crossfade');
  return parseScene({...initial,transition:{...initial.transition!,a,b,...settings}});
}
function blend(stage:Stage):FakeParam {
  const target=[...stage.node.targets][0] as FakeNode&{gain:FakeParam};return target.gain;
}
function deferred<T>(){
  let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
afterEach(()=>mixers.splice(0).forEach(mixer=>mixer.dispose()));

describe('saved mix transition playback',()=>{
  it('keeps duplicate layer IDs, solo scopes and captured masters separate before one final output',async()=>{
    const {mixer,context,stages}=setup();
    const a=capture('a',{masterGain:.4,masterEqualizer:{bassDb:3,midDb:0,trebleDb:0,bypassed:false}},[
      fixtureLayer({id:'same',assetId:'a',solo:true,gain:.6}),fixtureLayer({id:'other',assetId:'a',gain:.8})]);
    const b=capture('b',{masterGain:.7,outputLimiter:{enabled:true,ceilingDb:-5}},[fixtureLayer({id:'same',assetId:'b',gain:.9})]);
    await mixer.setScene(arrangement(a,b,{blend:.25}));await mixer.play();
    expect(context.sources).toHaveLength(3);expect(stages).toHaveLength(3);
    expect(stages.map(stage=>stage.settings?.ceilingDb)).toEqual([-1,-1,-5]);
    expect(context.gains.find(node=>node.targets.has(stages[1]!.node))!.gain.valueAt(0)).toBe(.4);
    expect(context.gains.find(node=>node.targets.has(stages[2]!.node))!.gain.valueAt(0)).toBe(.7);
    const levels=context.panners.map(pan=>context.gains.find(node=>node.targets.has(pan))!.gain.valueAt(0));
    expect(levels).toEqual([.6,0,.9]);expect(blend(stages[1]!).valueAt(0)).toBe(.75);expect(blend(stages[2]!).valueAt(0)).toBe(.25);
    expect(context.gains[0]!.targets.has(stages[0]!.node)).toBe(true);
    const meter=[...stages[0]!.node.targets][0] as FakeNode;expect(meter.targets.has(context.destination)).toBe(true);
    let output!:OutputMeterSnapshot;mixer.subscribeOutput(value=>{output=value;});
    stages[1]!.emit({...emptyOutputMeterSnapshot(),available:true,peak:[1,1]});expect(output.peak).toEqual([0,0]);
  });

  it('schedules the waiting interval, complete linear fade and held B without display ticks',async()=>{
    const {mixer,context,stages,observe}=setup();
    await mixer.setScene(arrangement(undefined,undefined,{mode:'timed',blend:.2,startSeconds:2,durationSeconds:4}));await mixer.play();
    const a=blend(stages[1]!),b=blend(stages[2]!);
    for(const [time,value] of [[0,.2],[1,.2],[2,.2],[4,.6],[6,1],[100,1]]){
      expect(b.valueAt(time!)).toBeCloseTo(value!,7);expect(a.valueAt(time!)+b.valueAt(time!)).toBeCloseTo(1,7);
    }
    context.currentTime=4;expect(observe().transition).toMatchObject({phase:'running',remainingSeconds:2});expect(observe().transition!.blend).toBeCloseTo(.6,9);
    context.currentTime=100;expect(observe()).toMatchObject({state:'playing',transition:{blend:1,phase:'complete',remainingSeconds:0}});
  });

  it('holds both clocks on pause, resumes the remaining fade, and restarts the saved wait',async()=>{
    const {mixer,context,stages,observe}=setup();const recipe=arrangement(undefined,undefined,{mode:'timed',startSeconds:1,durationSeconds:4});
    await mixer.setScene(recipe);await mixer.play();context.currentTime=2;mixer.pause();
    expect(observe()).toMatchObject({state:'paused',positionSeconds:2,transition:{blend:.25}});
    expect(blend(stages[2]!).valueAt(10)).toBe(.25);
    context.currentTime=10;await mixer.play();
    expect(context.sources.slice(2).every(source=>source.starts[0]![0]===10)).toBe(true);
    expect(blend(stages[2]!).valueAt(11)).toBeCloseTo(.5,7);expect(blend(stages[2]!).valueAt(13)).toBe(1);
    context.currentTime=11;mixer.stop();context.currentTime=12;await mixer.play();
    expect(observe()).toMatchObject({positionSeconds:0,transition:{blend:0,phase:'waiting'}});
    expect(blend(stages[2]!).valueAt(13)).toBe(0);expect(blend(stages[2]!).valueAt(17)).toBe(1);
  });

  it('samples exact automation on subscription and lets manual cancellation hold it without restarting sources',async()=>{
    const {mixer,context,stages,observe}=setup();const recipe=arrangement(undefined,undefined,{mode:'timed',durationSeconds:4});
    await mixer.setScene(recipe);await mixer.play();context.currentTime=1.234;
    const held=observe().transition!.blend;expect(held).toBeCloseTo(1.234/4,9);
    const sources=[...context.sources];mixer.apply({type:'setTransition',transition:{...recipe.transition!,mode:'manual',blend:held}});
    expect(context.sources).toEqual(sources);expect(blend(stages[2]!).valueAt(50)).toBeCloseTo(held,9);
    context.currentTime=2;mixer.apply({type:'setTransition',transition:{...recipe.transition!,mode:'manual',blend:.8}});
    expect(blend(stages[2]!).valueAt(2)).toBeCloseTo(held,9);expect(blend(stages[2]!).valueAt(2.02)).toBe(.8);
    expect(blend(stages[1]!).valueAt(2.01)+blend(stages[2]!).valueAt(2.01)).toBeCloseTo(1,9);
  });

  it('retains each source timer and finite endpoint while the other side continues',async()=>{
    const {mixer,context,stages,observe}=setup();
    const a=capture('a',{listeningTimer:{enabled:true,durationSeconds:2,fadeInSeconds:.5,fadeOutSeconds:.5}});
    await mixer.setScene(arrangement(a,capture('b'),{blend:.5}));await mixer.play();
    expect(stages[1]!.listeningGain.valueAt(.25)).toBe(.5);expect(stages[1]!.listeningGain.valueAt(1.75)).toBe(.5);
    expect(stages[1]!.listeningGain.valueAt(2)).toBe(0);expect(stages[2]!.listeningGain.valueAt(20)).toBe(1);
    expect(context.sources[0]!.stops).toEqual([2]);expect(context.sources[1]!.stops).toEqual([]);
    context.currentTime=3;expect(observe().state).toBe('playing');
    const finite=capture('short',{durationSeconds:1});await mixer.setScene(arrangement(finite,capture('b')));await mixer.play();
    expect(stages[3]!.listeningGain.valueAt(4)).toBe(0);
  });

  it('finishes a later timed fade in silence and retains its completed endpoint until replay',async()=>{
    let tick=()=>{};const {mixer,context,stages,observe}=setup({scheduleTick:callback=>{tick=callback;return()=>{tick=()=>{};};}});
    const recipe=arrangement(capture('a',{durationSeconds:2}),capture('b',{durationSeconds:4}),{mode:'timed',startSeconds:1,durationSeconds:9});
    await mixer.setScene(recipe);await mixer.play();context.currentTime=5;tick();
    expect(observe()).toMatchObject({state:'playing',positionSeconds:5,transition:{phase:'running',remainingSeconds:5}});
    expect(stages[1]!.listeningGain.valueAt(5)).toBe(0);expect(stages[2]!.listeningGain.valueAt(5)).toBe(0);
    context.currentTime=10;tick();expect(observe()).toMatchObject({state:'ready',positionSeconds:10,transition:{blend:1,phase:'complete',remainingSeconds:0}});
    context.currentTime=12;await mixer.play();expect(observe()).toMatchObject({state:'playing',positionSeconds:0,transition:{blend:0,phase:'waiting'}});
    expect(stages[1]!.listeningGain.valueAt(12)).toBe(1);expect(blend(stages[2]!).valueAt(22)).toBe(1);
  });

  it('prepares B without touching A and joins at the current shared position',async()=>{
    const pending=deferred<AudioBuffer>();const {mixer,context,stages,observe}=setup({loadAsset:async id=>id==='b'?pending.promise:fakeBuffer(2,480000)});
    const a=capture('a',{},[fixtureLayer({assetId:'a',gain:1})]),b=capture('b',{},[fixtureLayer({assetId:'b',gain:1})]);
    const before=arrangement(a,null,{blend:.5});await mixer.setScene(before);await mixer.play();context.currentTime=2;
    const source=context.sources[0]!,stops=[...source.stops];const replacing=mixer.updateScene(arrangement(a,b,{blend:.5}));
    expect(blend(stages[1]!).valueAt(2)).toBe(1);expect(context.sources).toEqual([source]);
    pending.resolve(fakeBuffer(2,480000));await replacing;
    expect(source.stops).toEqual(stops);expect(source.starts).toEqual([[0,0,undefined]]);
    expect(context.sources[1]!.starts).toEqual([[2,2,undefined]]);expect(observe().positionSeconds).toBe(2);
    expect(blend(stages[1]!).valueAt(2.02)).toBe(.5);expect(blend(stages[2]!).valueAt(2)).toBe(.5);
  });

  it('keeps both accepted sides when replacement decoding or source processor preparation fails',async()=>{
    const stages:Stage[]=[];let fail=false;
    const {mixer,context,observe}=setup({loadAsset:async id=>{if(id==='missing')throw new Error('Unavailable recording');return fakeBuffer(2,480000);},
      createOutputStage:async()=>{if(fail)throw new Error('Source processor allocation failed');const stage=new Stage();stages.push(stage);return stage as unknown as MixerOutputStage;}});
    const a=capture('a'),b=capture('b');await mixer.setScene(arrangement(a,b,{blend:.5}));await mixer.play();context.currentTime=1;
    const sources=[...context.sources],stops=sources.map(source=>[...source.stops]);
    await expect(mixer.updateScene(arrangement(a,capture('missing')))).rejects.toThrow('Unavailable recording');
    fail=true;await expect(mixer.updateScene(arrangement(a,capture('replacement')))).rejects.toThrow('Source processor allocation failed');
    expect(observe()).toMatchObject({state:'playing',positionSeconds:1,loadedAssetIds:['a','b']});
    expect(context.sources).toEqual(sources);expect(sources.map(source=>source.stops)).toEqual(stops);
    expect(stages.every(stage=>!stage.disposed)).toBe(true);expect(blend(stages[2]!).valueAt(10)).toBe(.5);
  });

  it('supersedes an obsolete B decode and retains master changes made during preparation',async()=>{
    const slow=deferred<AudioBuffer>();const {mixer,context,observe}=setup({loadAsset:async id=>id==='slow'?slow.promise:fakeBuffer(2,480000)});
    const a=capture('a');await mixer.setScene(arrangement(a,null));await mixer.play();context.currentTime=1;
    const stale=mixer.updateScene(arrangement(a,capture('slow')));
    await mixer.updateScene(arrangement(a,capture('new')));mixer.apply({type:'setMasterGain',gain:.6});
    slow.resolve(fakeBuffer(2,480000));await stale;
    expect(observe()).toMatchObject({state:'playing',positionSeconds:1,loadedAssetIds:['a','new']});
    expect(context.sources).toHaveLength(2);expect(context.gains[0]!.gain.valueAt(1.02)).toBe(.6);
  });

  it('does not start a newly decoded side after pause, stop or audio interruption',async()=>{
    for(const action of ['pause','stop','interrupt'] as const){
      const pending=deferred<AudioBuffer>();const {mixer,context,observe}=setup({loadAsset:async id=>id==='b'?pending.promise:fakeBuffer(2,480000)});
      const a=capture('a');await mixer.setScene(arrangement(a,null));await mixer.play();context.currentTime=1;
      const replacing=mixer.updateScene(arrangement(a,capture('b')));
      if(action==='interrupt')context.interrupt();else mixer[action]();
      pending.resolve(fakeBuffer(2,480000));await replacing;
      expect(context.sources).toHaveLength(1);expect(observe().state).toBe(action==='stop'?'ready':action==='pause'?'paused':'interrupted');
      expect(observe().positionSeconds).toBe(action==='stop'?0:1);await mixer.play();expect(context.sources).toHaveLength(3);
    }
  });

  it('shares decoded and prepared loop buffers while enforcing the combined budget',async()=>{
    let loads=0;const {mixer,context,observe}=setup({decodedBudgetBytes:691200,loadAsset:async()=>{loads++;return fakeBuffer(2,48000);}});
    const layer:Layer=fixtureLayer({assetId:'shared',loop:{startSeconds:0,endSeconds:1,crossfadeSeconds:.2}});
    const a=capture('a',{},[layer]),b=capture('b',{},[layer]);const recipe=arrangement(a,b,{blend:.5});
    await mixer.setScene(recipe);await mixer.play();expect(loads).toBe(1);expect(context.createdBuffers).toHaveLength(1);
    expect(new Set(context.sources.filter(source=>source.loop).map(source=>source.buffer)).size).toBe(1);
    context.currentTime=.25;const sources=[...context.sources];
    await expect(mixer.updateScene(arrangement(a,capture('other',{},[{...layer,loop:{...layer.loop!,crossfadeSeconds:.1}}])))).rejects.toThrow(/budget/);
    expect(context.createdBuffers).toHaveLength(1);expect(context.sources).toEqual(sources);expect(observe().state).toBe('playing');
  });

  it('uses captured durations for occasional timing and silences an ended B selected late',async()=>{
    const {mixer,context,stages}=setup({assetDurationSeconds:()=>.8,loadAsset:async()=>fakeBuffer(1,12000)});
    const settings={enabled:true,minPauseSeconds:.25,maxPauseSeconds:.25,seed:42,alternateAssetIds:[],levelVariation:0,panVariation:0};
    const raw=capture('a',{},[fixtureLayer({assetId:'a',occasional:settings})]);
    const a=parseCapturedMix({...raw,assets:raw.assets.map(asset=>({...asset,durationSeconds:.125}))});
    await mixer.setScene(arrangement(a,null));await mixer.play();
    expect(context.sources.slice(0,3).map(source=>source.starts[0]![0])).toEqual([0,.375,.75]);
    context.currentTime=2;const count=context.sources.length;
    await mixer.updateScene(arrangement(a,capture('b',{durationSeconds:1},[fixtureLayer({assetId:'b'})])));
    expect(context.sources).toHaveLength(count);expect(stages[2]!.listeningGain.valueAt(2.02)).toBe(0);
  });

  it('stops the arrangement on a captured processor fault and disposes every stage',async()=>{
    const {mixer,context,stages,observe}=setup();await mixer.setScene(arrangement());await mixer.play();
    stages[2]!.emit({...emptyOutputMeterSnapshot(),available:false,error:'Captured output failed'});
    expect(observe()).toMatchObject({state:'error',error:'Captured output failed'});expect(context.sources.every(source=>source.buffer===null)).toBe(true);
    await expect(mixer.play()).rejects.toThrow('Captured output failed');mixer.dispose();expect(stages.every(stage=>stage.disposed)).toBe(true);
  });

  it('rejects a candidate processor that faults between its creation and committing B',async()=>{
    class FailingStage extends Stage {
      override subscribe(listener:(snapshot:OutputMeterSnapshot)=>void){
        const unsubscribe=super.subscribe(listener);
        queueMicrotask(()=>this.emit({...emptyOutputMeterSnapshot(),error:'Candidate output failed'}));
        return unsubscribe;
      }
    }
    const stages:Stage[]=[];const {mixer,context,observe}=setup({createOutputStage:async()=>{
      const stage=stages.length===2?new FailingStage():new Stage();stages.push(stage);return stage as unknown as MixerOutputStage;
    }});
    const a=capture('a');await mixer.setScene(arrangement(a,null));await mixer.play();context.currentTime=1;
    const source=context.sources[0]!,stops=[...source.stops];
    await expect(mixer.updateScene(arrangement(a,capture('b'),{blend:.5}))).rejects.toThrow('Candidate output failed');
    expect(observe()).toMatchObject({state:'playing',loadedAssetIds:['a']});expect(context.sources).toEqual([source]);expect(source.stops).toEqual(stops);
    expect(blend(stages[1]!).valueAt(10)).toBe(1);expect(stages[2]!.disposed).toBe(true);
  });

  it('retires a removed side processor after its existing release tail ends',async()=>{
    const {mixer,context,stages}=setup();const recipe=arrangement(undefined,undefined,{blend:.5});
    await mixer.setScene(recipe);await mixer.play();context.currentTime=1;
    const removed=context.sources[1]!;
    mixer.apply({type:'setTransition',transition:{...recipe.transition!,b:null}});
    expect(removed.stops.at(-1)).toBe(1.02);expect(stages[2]!.disposed).toBe(false);
    removed.onended?.();expect(stages[2]!.disposed).toBe(true);expect(stages[1]!.disposed).toBe(false);
    expect(blend(stages[1]!).valueAt(1.02)).toBe(1);
  });
});
