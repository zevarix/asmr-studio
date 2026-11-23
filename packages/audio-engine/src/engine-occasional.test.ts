import {afterEach,describe,expect,it} from 'vitest';
import {createMixer} from './engine.js';
import {FakeContext,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureLayer,fixtureScene} from '../../../tests/fixtures/scene.js';
import type {Mixer,MixerOptions,PlaybackSnapshot} from './types.js';

const settings={enabled:true,minPauseSeconds:.25,maxPauseSeconds:.25,seed:42,alternateAssetIds:[] as string[],levelVariation:0,panVariation:0};
const recipe=(overrides:Partial<typeof settings>={})=>({...fixtureScene(),layers:[{...fixtureLayer(),occasional:{...settings,...overrides}}]});
const mixers:Mixer[]=[];
function setup(options:Partial<MixerOptions>={}){
  const context=new FakeContext();
  let tick:(()=>void)|undefined;
  const mixer=createMixer({context:context as unknown as AudioContext,decodedBudgetBytes:4_000_000,
    loadAsset:async()=>fakeBuffer(1,12000),scheduleTick:callback=>{tick=callback;return()=>{tick=undefined;};},...options});
  mixers.push(mixer);
  let snapshot:PlaybackSnapshot;
  mixer.subscribe(value=>{snapshot=value;});
  return {mixer,context,advance(time:number){context.currentTime=time;tick?.();},snapshot:()=>snapshot!};
}
afterEach(()=>mixers.splice(0).forEach(mixer=>mixer.dispose()));

describe('occasional playback',()=>{
  it('bounds native sources, skips missed events and resumes a late event once at its offset',async()=>{
    const {mixer,context,advance}=setup();
    await mixer.setScene(recipe());await mixer.play();
    expect(context.sources.map(source=>source.starts[0]![0])).toEqual([0,.5]);
    advance(3600.125);
    expect(context.sources.slice(2).map(source=>source.starts[0])).toEqual([
      [3600.125,.125,undefined],[3600.5,0,undefined],[3601,0,undefined]]);
    advance(3600.125);expect(context.sources).toHaveLength(5);
    expect(context.panners).toHaveLength(6);
  });
  it('cancels queued events on pause, resumes in a gap, stops and replays from zero',async()=>{
    const {mixer,context,advance,snapshot}=setup();
    await mixer.setScene(recipe());await mixer.play();advance(.3);mixer.pause();
    expect(context.sources.slice(1).every(source=>source.disconnected)).toBe(true);
    expect(snapshot().positionSeconds).toBe(.3);
    advance(10);const count=context.sources.length;await mixer.play();
    expect(context.sources[count]!.starts[0]![0]).toBeCloseTo(10.2);
    advance(10.3);mixer.pause();advance(15);
    const resumed=context.sources.length;await mixer.play();
    expect(context.sources[resumed]!.starts[0]![1]).toBeCloseTo(.1);
    mixer.stop();advance(20);const restart=context.sources.length;await mixer.play();
    expect(context.sources[restart]!.starts[0]).toEqual([20,0,undefined]);
  });
  it('uses canonical durations for starts, ignores saved loops, and retires only a changed layer',async()=>{
    const {mixer,context,advance}=setup({assetDurationSeconds:()=>.125});
    const layer={...recipe().layers[0]!,loop:{startSeconds:0,endSeconds:8,crossfadeSeconds:1}};
    const scene={...fixtureScene(),layers:[layer,{...fixtureLayer(),id:'steady'}]};
    await mixer.setScene(scene);await mixer.play();
    expect(context.sources.slice(0,3).map(source=>source.starts[0]![0])).toEqual([0,.375,.75]);
    expect(context.sources[0]!.stops).toEqual([.125]);expect(context.sources.every(source=>!source.loop)).toBe(true);
    const steady=context.sources[3]!;const stops=[...steady.stops];advance(.05);
    mixer.apply({type:'setLayerOccasional',layerId:layer.id,occasional:{...settings,minPauseSeconds:1,maxPauseSeconds:1}});
    expect(context.sources[1]!.disconnected).toBe(true);expect(steady.stops).toEqual(stops);
    const count=context.sources.length;
    mixer.apply({type:'setLayerGain',layerId:layer.id,gain:.7});expect(context.sources).toHaveLength(count);
  });
  it('preflights alternate availability and decoded memory without retiring playable audio',async()=>{
    const loaded:string[]=[];
    const {mixer,context,snapshot}=setup({decodedBudgetBytes:50000,loadAsset:async id=>{
      loaded.push(id);
      if(id==='missing')throw new Error('missing recording');
      return fakeBuffer(1,12000);
    }});
    await mixer.setScene(recipe());await mixer.play();const count=context.sources.length;
    await expect(mixer.updateScene(recipe({alternateAssetIds:['missing']}))).rejects.toThrow('missing recording');
    await expect(mixer.updateScene(recipe({alternateAssetIds:['extra','after-budget']}))).rejects.toThrow(/budget/);
    expect(loaded).not.toContain('after-budget');
    expect(snapshot().state).toBe('playing');expect(snapshot().loadedAssetIds).toEqual(['asset-rain']);
    expect(context.sources).toHaveLength(count);expect(context.sources[0]!.buffer).not.toBeNull();
  });
  it('keeps the event panner before the layer EQ and leaves layer movement on the layer panner',async()=>{
    const {mixer,context}=setup();
    const scene=recipe({seed:4,levelVariation:.25,panVariation:.25});
    const layer={...scene.layers[0]!,pan:.4,movement:{enabled:true,width:.2,cycleSeconds:30}};
    await mixer.setScene({...scene,layers:[layer]});await mixer.play();
    const [layerPan,eventPan]=context.panners;
    const envelope=[...context.sources[0]!.targets][0];
    expect(context.gains.find(node=>node===envelope)?.targets.has(eventPan)).toBe(true);
    expect(eventPan!.targets.has(context.filters[3])).toBe(true);
    expect(Math.abs(eventPan!.pan.value)).toBeGreaterThan(0);
    expect(layerPan!.pan.inputs.size).toBe(2);expect(eventPan!.pan.inputs.size).toBe(0);
    const peak=context.gains.find(node=>node===envelope)!.gain.valueAt(.1);
    expect(peak).toBeGreaterThanOrEqual(.75);expect(peak).toBeLessThan(1);
  });
  it('clips the last event at the listening deadline and cannot refill after a late completion tick',async()=>{
    const {mixer,context,advance,snapshot}=setup();
    const listeningTimer={enabled:true,durationSeconds:1,fadeInSeconds:0,fadeOutSeconds:.25};
    const scene=recipe();await mixer.setScene({...scene,listeningTimer,layers:[{...scene.layers[0]!,startSeconds:.4}]});
    await mixer.play();expect(context.sources.map(source=>source.stops[0])).toEqual([.65,1]);
    advance(2);expect(context.sources).toHaveLength(2);expect(snapshot().state).toBe('ready');
    expect(snapshot().positionSeconds).toBe(1);
  });
  it('accepts the latest synchronous edit when a removed alternate fails to decode',async()=>{
    let reject!:(error:Error)=>void;
    const late=new Promise<AudioBuffer>((_,fail)=>{reject=fail;});
    const {mixer,context,snapshot}=setup({loadAsset:async id=>id==='late'?late:fakeBuffer(1,12000)});
    await mixer.setScene(recipe());await mixer.play();
    const pending=mixer.updateScene(recipe({alternateAssetIds:['late']}));
    mixer.apply({type:'setLayerOccasional',layerId:'ambience',occasional:settings});
    reject(new Error('recording unavailable'));await pending;
    expect(snapshot().error).toBeNull();expect(snapshot().loadedAssetIds).toEqual(['asset-rain']);
    expect(context.sources).toHaveLength(2);
  });
  it('ignores a superseded alternate decode after the latest scene commits',async()=>{
    let complete!:(buffer:AudioBuffer)=>void;
    const late=new Promise<AudioBuffer>(resolve=>{complete=resolve;});
    const {mixer,context,snapshot}=setup({loadAsset:async id=>id==='late'?late:fakeBuffer(1,12000)});
    await mixer.setScene(recipe());await mixer.play();
    const stale=mixer.updateScene(recipe({alternateAssetIds:['late']}));
    await mixer.updateScene(recipe({alternateAssetIds:['new']}));
    const count=context.sources.length;complete(fakeBuffer(1,12000));await stale;
    expect(snapshot().loadedAssetIds).toEqual(['asset-rain','new']);expect(context.sources).toHaveLength(count);
  });
});
