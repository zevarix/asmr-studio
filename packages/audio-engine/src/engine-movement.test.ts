import {afterEach,describe,expect,it} from 'vitest';
import {createMixer} from './engine.js';
import type {Mixer,PlaybackSnapshot} from './types.js';
import {FakeContext,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureLayer,fixtureScene} from '../../../tests/fixtures/scene.js';

const sway={enabled:true,width:.4,cycleSeconds:2};
const mixers:Mixer[]=[];
function create(context=new FakeContext(),withoutHold=false){
  if(withoutHold){
    const removeHold=(param:unknown)=>Object.defineProperty(param,'cancelAndHoldAtTime',{value:undefined});
    const gain=context.createGain.bind(context),pan=context.createStereoPanner.bind(context),oscillator=context.createOscillator.bind(context);
    context.createGain=()=>{const node=gain();removeHold(node.gain);return node;};
    context.createStereoPanner=()=>{const node=pan();removeHold(node.pan);return node;};
    context.createOscillator=()=>{const node=oscillator();removeHold(node.frequency);return node;};
  }
  const mixer=createMixer({context:context as unknown as AudioContext,loadAsset:async()=>fakeBuffer(2,480000),decodedBudgetBytes:16*1024*1024});
  mixers.push(mixer);let snapshot!:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});
  return {context,mixer,snapshot:()=>snapshot};
}
function scene(movement?:typeof sway,startSeconds=0){return {...fixtureScene(),layers:[fixtureLayer({movement:arguments.length===0?sway:movement,startSeconds})]};}
afterEach(()=>mixers.splice(0).forEach(mixer=>mixer.dispose()));

describe('audio-clock layer movement',()=>{
  it('keeps the legacy static graph without oscillators when movement is absent, off, or zero width',async()=>{
    for(const movement of [undefined,{...sway,enabled:false},{...sway,width:0}]){
      const {context,mixer}=create();await mixer.setScene(scene(movement));await mixer.play();
      expect(context.oscillators).toHaveLength(0);expect(context.gains).toHaveLength(3);
      expect(context.panners[0]!.pan.computedAt(.5)).toBe(0);
    }
  });
  it('starts at center and schedules delayed movement with the same audio clock as the recording',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene(sway,.5));await mixer.play();
    expect(context.oscillators).toHaveLength(2);
    const pan=context.panners[0]!.pan;
    expect(pan.computedAt(.49)).toBe(0);expect(pan.computedAt(.5)).toBe(0);
    expect(pan.computedAt(1)).toBeCloseTo(.4,6);expect(pan.computedAt(2)).toBeCloseTo(-.4,6);
    expect(context.sources[0]!.starts[0]![0]).toBe(.5);
  });
  it('freezes phase on pause and interruption, then resumes the held phase',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene());await mixer.play();
    const pan=context.panners[0]!.pan;
    context.currentTime=.4;const held=pan.computedAt(.4);mixer.pause();
    expect(pan.computedAt(1.4)).toBeCloseTo(held,6);
    context.currentTime=1.4;await mixer.play();expect(pan.computedAt(1.4)).toBeCloseTo(held,6);
    expect(pan.computedAt(1.9)).toBeCloseTo(.4*Math.sin(.9*Math.PI),6);
    context.currentTime=1.9;const interrupted=pan.computedAt(1.9);context.interrupt();
    expect(pan.computedAt(3)).toBeCloseTo(interrupted,6);
    context.currentTime=3;await mixer.play();expect(pan.computedAt(3)).toBeCloseTo(interrupted,6);
    expect(context.oscillators).toHaveLength(2);
  });
  it('preserves the remaining delay when paused before a layer starts',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene(sway,.5));await mixer.play();const pan=context.panners[0]!.pan;
    context.currentTime=.2;mixer.pause();expect(pan.computedAt(1.2)).toBe(0);
    context.currentTime=1.2;await mixer.play();expect(pan.computedAt(1.49)).toBe(0);expect(pan.computedAt(1.5)).toBe(0);
    expect(pan.computedAt(2)).toBeCloseTo(.4,6);expect(context.sources.at(-1)!.starts[0]![0]).toBe(1.5);
    expect(context.oscillators).toHaveLength(2);
  });
  for(const start of [.25,1.25])it(`reinitializes a paused layer retimed to ${start}s without changing its held pan or release`,async()=>{
    const {context,mixer}=create();await mixer.setScene(scene());await mixer.play();const pan=context.panners[0]!.pan;
    context.currentTime=.75;mixer.pause();const held=pan.computedAt(.75),stops=[...context.sources[0]!.stops];
    context.currentTime=.755;await mixer.updateScene(scene(sway,start));
    expect(pan.computedAt(.755)).toBeCloseTo(held,6);expect(pan.computedAt(1.75)).toBeCloseTo(held,6);
    expect(context.sources).toHaveLength(1);expect(context.sources[0]!.stops).toEqual(stops);
    context.currentTime=1.75;await mixer.play();expect(pan.computedAt(1.75)).toBeCloseTo(held,6);
    const elapsed=Math.max(0,.75-start),delay=Math.max(0,start-.75),begins=1.75+delay;
    expect(context.sources.at(-1)!.starts[0]!.slice(0,2)).toEqual([begins,elapsed]);
    if(delay>0){expect(pan.computedAt(begins-.01)).toBeCloseTo(0,7);expect(pan.computedAt(begins)).toBeCloseTo(0,7);}
    expect(pan.computedAt(begins+.1)).toBeCloseTo(.4*Math.sin(Math.PI*(elapsed+.1)),6);
    expect(context.oscillators).toHaveLength(2);
  });
  it('changes cycle speed continuously without resetting phase, sources, or transport',async()=>{
    const {context,mixer,snapshot}=create();await mixer.setScene(scene({...sway,cycleSeconds:4}));await mixer.play();
    const source=context.sources[0]!,pan=context.panners[0]!.pan;
    context.currentTime=.5;const before=pan.computedAt(.5);
    mixer.apply({type:'setLayerMovement',layerId:'ambience',movement:sway});
    expect(pan.computedAt(.5)).toBeCloseTo(before,6);
    expect(pan.computedAt(.52)).toBeCloseTo(.4*Math.sin(2*Math.PI*(.125+.02*.375)),6);
    expect(context.sources).toEqual([source]);expect(source.starts).toHaveLength(1);expect(snapshot().positionSeconds).toBe(.5);
    const frequencyEvents=structuredClone(context.oscillators[0]!.frequency.events);
    context.currentTime=.6;mixer.apply({type:'setMasterGain',gain:.3});
    expect(context.oscillators[0]!.frequency.events).toEqual(frequencyEvents);
  });
  it('keeps rapid stop/play transitions continuous and bounded while restarting the movement phase',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene());await mixer.play();const pan=context.panners[0]!.pan;
    for(const time of [.5,.505,.51]){
      context.currentTime=time;const before=pan.computedAt(time);mixer.stop();await mixer.play();
      expect(pan.computedAt(time)).toBeCloseTo(before,6);
    }
    for(let i=0;i<60;i++)expect(Math.abs(pan.computedAt(.51+i/1000))).toBeLessThanOrEqual(.400001);
    expect(pan.computedAt(.55)).toBeCloseTo(.4*Math.sin(.04*Math.PI),6);
    expect(context.oscillators).toHaveLength(2);
  });
  for(const withoutHold of [false,true])it(`preserves interrupted ramps at a repeated restart boundary (native hold: ${!withoutHold})`,async()=>{
    const {context,mixer}=create(new FakeContext(),withoutHold);await mixer.setScene(scene());await mixer.play();
    context.currentTime=.5013333333333333;mixer.stop();await mixer.play();
    const at=.5066666666666667,before=at-1/context.sampleRate,pan=context.panners[0]!.pan,incoming=context.gains.at(-1)!.gain;
    const previousPan=pan.computedAt(before),previousLevel=incoming.valueAt(before);
    context.currentTime=at;mixer.stop();await mixer.play();
    // Retain the original ramps up to the edit boundary, including the sub-sample
    // interval that native AudioParams can render before a rounded event time.
    expect(pan.computedAt(before)).toBeCloseTo(previousPan,7);
    expect(incoming.valueAt(before)).toBeCloseTo(previousLevel,7);
  });
  it('ramps center and width together, retains phase when bypassed, and keeps mute/solo independent',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene());await mixer.play();const pan=context.panners[0]!.pan;
    context.currentTime=.5;mixer.apply({type:'setLayerMovement',layerId:'ambience',movement:{...sway,enabled:false}});
    expect(pan.computedAt(.51)).toBeCloseTo(.2*Math.sin(.51*Math.PI),6);
    expect(pan.computedAt(.53)).toBe(0);
    context.currentTime=.6;mixer.apply({type:'setLayerMovement',layerId:'ambience',movement:sway});
    context.currentTime=.605;mixer.apply({type:'setLayerPan',layerId:'ambience',pan:.95});
    for(let i=0;i<200;i++)expect(Math.abs(pan.computedAt(.605+i/1000))).toBeLessThanOrEqual(1.000001);
    const events=structuredClone(context.oscillators[0]!.frequency.events);
    mixer.apply({type:'setMuted',layerId:'ambience',muted:true});mixer.apply({type:'setSolo',layerId:'ambience',solo:true});
    expect(context.oscillators[0]!.frequency.events).toEqual(events);expect(context.sources).toHaveLength(1);
  });
  it('initializes a newly added layer from its position in the current scene',async()=>{
    const {context,mixer}=create();const original=scene(undefined);await mixer.setScene(original);await mixer.play();
    context.currentTime=.5;await mixer.updateScene({...original,layers:[...original.layers,fixtureLayer({id:'new',movement:sway,startSeconds:.1})]});
    expect(context.panners[1]!.pan.computedAt(.5)).toBeCloseTo(.4*Math.sin(.4*Math.PI),6);
    expect(context.sources[0]!.starts).toHaveLength(1);
  });
  for(const failsAt of [1,2])it(`rejects oscillator allocation ${failsAt} before changing accepted controls or playback`,async()=>{
    const {context,mixer,snapshot}=create();await mixer.setScene(scene({...sway,enabled:false}));await mixer.play();context.currentTime=.5;
    const pan=context.panners[0]!.pan;const before=structuredClone(pan.events);const original=context.createOscillator.bind(context);
    const stops=[...context.sources[0]!.stops];
    let allocation=0;context.createOscillator=()=>{if(++allocation===failsAt)throw new Error('Oscillator allocation failed');return original();};
    expect(()=>mixer.apply({type:'setLayerMovement',layerId:'ambience',movement:sway})).toThrow('Oscillator allocation failed');
    expect(pan.events).toEqual(before);expect(context.sources).toHaveLength(1);expect(context.sources[0]!.stops).toEqual(stops);
    expect(pan.inputs.size).toBe(0);expect(context.oscillators.every(node=>node.disconnected)).toBe(true);
    expect(snapshot().state).toBe('playing');
    context.createOscillator=original;mixer.apply({type:'setLayerMovement',layerId:'ambience',movement:sway});
    expect(pan.computedAt(.52)).toBeCloseTo(.4*Math.sin(.52*Math.PI),6);
    expect(snapshot()).toMatchObject({state:'playing',positionSeconds:.5});
  });
  it('rolls back silent allocations when a later layer fails preflight, leaving the accepted mix playing',async()=>{
    const {context,mixer,snapshot}=create();const original={...scene({...sway,enabled:false}),layers:[
      fixtureLayer({movement:{...sway,enabled:false}}),fixtureLayer({id:'two',movement:{...sway,enabled:false}}),
    ]};
    await mixer.setScene(original);await mixer.play();context.currentTime=.5;
    const sourceStops=context.sources.map(source=>[...source.stops]);const panEvents=context.panners.map(node=>structuredClone(node.pan.events));
    const createWave=context.createPeriodicWave.bind(context);let allocations=0;
    context.createPeriodicWave=(...args)=>{if(++allocations===2)throw new Error('Wave allocation failed');return createWave(...args);};
    const next={...original,layers:original.layers.map(layer=>({...layer,movement:sway}))};
    await expect(mixer.updateScene(next)).rejects.toThrow('Wave allocation failed');
    expect(context.sources).toHaveLength(2);expect(context.sources.map(source=>source.stops)).toEqual(sourceStops);
    expect(context.panners.map(node=>node.pan.events)).toEqual(panEvents);
    expect(context.panners.every(node=>node.pan.inputs.size===0)).toBe(true);
    expect(context.oscillators).toHaveLength(4);expect(context.oscillators.every(node=>node.disconnected)).toBe(true);
    expect(snapshot()).toMatchObject({state:'playing',positionSeconds:.5});
    context.createPeriodicWave=createWave;await mixer.updateScene(next);
    expect(context.panners.every(node=>node.pan.inputs.size===2)).toBe(true);
    for(const node of context.panners)expect(node.pan.computedAt(.52)).toBeCloseTo(.4*Math.sin(.52*Math.PI),6);
    expect(context.sources).toHaveLength(2);
  });
  it('replays existing movement without allocating any new oscillator or wave',async()=>{
    const {context,mixer,snapshot}=create();await mixer.setScene({...scene(),layers:[fixtureLayer({movement:sway}),fixtureLayer({id:'two',movement:sway})]});
    context.createPeriodicWave=()=>{throw new Error('Unexpected wave allocation');};
    context.createOscillator=()=>{throw new Error('Unexpected oscillator allocation');};
    await mixer.play();context.currentTime=.5;mixer.stop();context.currentTime=1;await mixer.play();
    expect(snapshot()).toMatchObject({state:'playing',positionSeconds:0});expect(context.sources).toHaveLength(4);
    expect(context.oscillators).toHaveLength(4);for(const node of context.panners)expect(node.pan.computedAt(1.5)).toBeCloseTo(.4,6);
  });
  it('disposes movement owners after a removed layer release and on scene replacement',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=.5;
    const oscillator=context.oscillators[0]!;mixer.apply({type:'removeLayer',layerId:'ambience'});
    expect(oscillator.disconnected).toBe(false);context.sources[0]!.onended?.();expect(oscillator.disconnected).toBe(true);
    await mixer.setScene(scene());await mixer.play();await mixer.setScene({...scene(undefined),id:'other'});
    expect(context.oscillators.every(node=>node.disconnected)).toBe(true);
    mixer.dispose();expect(context.nodes.every(node=>node.disconnected)).toBe(true);
  });
});
