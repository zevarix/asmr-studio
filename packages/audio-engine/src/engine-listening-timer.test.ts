import {afterEach,describe,expect,it,vi} from 'vitest';
import {createMixer} from './engine.js';
import type {Mixer,PlaybackSnapshot} from './types.js';
import {FakeContext,FakeParam,fakeBuffer} from './test-utils/fake-context.js';
import {fixtureLayer,fixtureScene} from '../../../tests/fixtures/scene.js';

const settings={enabled:true,durationSeconds:4,fadeInSeconds:1,fadeOutSeconds:1};
const mixers:Mixer[]=[];
function create(){
  const context=new FakeContext();
  const mixer=createMixer({context:context as unknown as AudioContext,loadAsset:async()=>fakeBuffer(2,480000),decodedBudgetBytes:8_000_000});
  mixers.push(mixer);let snapshot!:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});
  const observe=()=>{const unsubscribe=mixer.subscribe(()=>{});unsubscribe();return snapshot;};
  return {context,mixer,observe};
}
function scene(timer=settings){return {...fixtureScene(),masterGain:1,layers:[fixtureLayer({gain:1,loop:{startSeconds:0,endSeconds:2,crossfadeSeconds:0}})],listeningTimer:timer};}
function outputGain(context:FakeContext):FakeParam {
  const gain=context.gains.find(node=>context.gains[0]!.targets.has(node));
  if(!gain)throw new Error('No post-master listening gain');return gain.gain;
}
afterEach(()=>{mixers.splice(0).forEach(mixer=>mixer.dispose());vi.useRealTimers();});

describe('listening timer transport and output automation',()=>{
  it('keeps legacy duration behavior and lets explicit Off override it',async()=>{
    const {context,mixer,observe}=create();const base={...fixtureScene(),durationSeconds:2,layers:[fixtureLayer({loop:{startSeconds:0,endSeconds:2,crossfadeSeconds:0}})]};
    await mixer.setScene(base);await mixer.play();expect(context.sources[0]!.stops).toEqual([2]);expect(observe().listeningTimer).toBeUndefined();
    expect(context.gains[0]!.targets.has(context.gains[1]!)).toBe(false);
    await mixer.setScene({...base,listeningTimer:{...settings,enabled:false}});await mixer.play();
    expect(context.sources.at(-1)!.stops).toEqual([]);expect(outputGain(context).valueAt(20)).toBe(1);expect(observe().listeningTimer).toBeUndefined();
  });
  it('schedules the whole fade and exact output gate without a UI callback',async()=>{
    vi.useFakeTimers();const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();
    const gain=outputGain(context);
    expect(gain.valueAt(0)).toBe(0);expect(gain.valueAt(.5)).toBeCloseTo(.5,7);expect(gain.valueAt(2)).toBe(1);
    expect(gain.valueAt(3.5)).toBeCloseTo(.5,7);expect(gain.valueAt(4)).toBe(0);expect(gain.valueAt(20)).toBe(0);
    expect(context.sources[0]!.stops.at(-1)).toBe(4);
    context.currentTime=5;await vi.advanceTimersByTimeAsync(100);
    expect(observe()).toMatchObject({state:'ready',positionSeconds:4,listeningTimer:{remainingSeconds:0,phase:'finished',gain:0}});
  });
  it('freezes gain and countdown on pause and resumes the remaining curve',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();
    context.currentTime=.5;mixer.pause();const gain=outputGain(context);
    expect(gain.valueAt(3)).toBeCloseTo(.5,7);expect(observe().listeningTimer?.remainingSeconds).toBe(3.5);
    context.currentTime=3;await mixer.play();expect(gain.valueAt(3)).toBeCloseTo(.5,7);expect(gain.valueAt(3.5)).toBe(1);
    expect(gain.valueAt(6.5)).toBe(0);expect(context.sources.at(-1)!.starts[0]!.slice(0,2)).toEqual([3,.5]);
  });
  it('recognizes an already finished timer before handling a delayed interruption callback',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=4.1;context.interrupt();
    expect(observe()).toMatchObject({state:'ready',positionSeconds:4,listeningTimer:{remainingSeconds:0,phase:'finished',gain:0}});
    await context.resume();expect(observe().state).toBe('ready');expect(context.sources).toHaveLength(1);
    await mixer.play();expect(observe()).toMatchObject({state:'playing',positionSeconds:0,listeningTimer:{remainingSeconds:4}});
  });
  it('keeps a completed timer silent when a pending asset decode resolves after its deadline',async()=>{
    const context=new FakeContext();let finishLoad!:(buffer:AudioBuffer)=>void;
    const delayed=new Promise<AudioBuffer>(resolve=>{finishLoad=resolve;});
    const mixer=createMixer({context:context as unknown as AudioContext,loadAsset:async id=>id==='later'?delayed:fakeBuffer(2,480000),decodedBudgetBytes:12_000_000});mixers.push(mixer);
    let snapshot!:PlaybackSnapshot;mixer.subscribe(value=>{snapshot=value;});const saved=scene();await mixer.setScene(saved);await mixer.play();context.currentTime=2;
    const editing=mixer.updateScene({...saved,layers:[...saved.layers,{...saved.layers[0]!,id:'second',assetId:'later'}]});
    context.currentTime=5;finishLoad(fakeBuffer(2,480000));await editing;
    expect(snapshot).toMatchObject({state:'ready',positionSeconds:4,listeningTimer:{remainingSeconds:0,phase:'finished',gain:0}});
    expect(context.sources).toHaveLength(1);expect(outputGain(context).valueAt(5)).toBe(0);
    await mixer.play();expect(snapshot).toMatchObject({state:'playing',positionSeconds:0,listeningTimer:{remainingSeconds:4}});expect(context.sources).toHaveLength(3);
  });
  it('holds an interrupted edit bridge on pause, then resumes without a gain step',async()=>{
    const {context,mixer}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=.5;
    mixer.apply({type:'setListeningTimer',timer:{...settings,fadeInSeconds:2}});
    context.currentTime=.51;const gain=outputGain(context),held=gain.valueAt(.51);mixer.pause();expect(gain.valueAt(5)).toBeCloseTo(held,7);
    context.currentTime=5;await mixer.play();expect(gain.valueAt(5)).toBeCloseTo(held,7);expect(gain.valueAt(5.02)).toBeCloseTo(.265,7);
  });
  it('blends a rapid restart but starts a later fresh fade without an initial burst',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=.5;
    const gain=outputGain(context);mixer.stop();await mixer.play();expect(gain.valueAt(.5)).toBeCloseTo(.5,7);expect(gain.valueAt(.52)).toBeCloseTo(.02,7);
    context.currentTime=.6;mixer.stop();context.currentTime=1;await mixer.play();expect(gain.valueAt(1)).toBe(0);expect(gain.valueAt(1.01)).toBeCloseTo(.01,7);
    expect(observe().positionSeconds).toBe(0);
  });
  it('changes only the gain curve for a fade-only edit and retains the playback clock',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=.5;
    const source=context.sources[0]!,gain=outputGain(context);
    mixer.apply({type:'setListeningTimer',timer:{...settings,fadeInSeconds:2}});
    expect(context.sources).toEqual([source]);expect(gain.valueAt(.5)).toBeCloseTo(.5,7);expect(gain.valueAt(.52)).toBeCloseTo(.26,7);
    expect(observe().positionSeconds).toBe(.5);expect(gain.valueAt(4)).toBe(0);
  });
  it('extends and disables the timer using compensated sources at the same elapsed offsets',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=1.5;
    mixer.apply({type:'setListeningTimer',timer:{...settings,durationSeconds:6}});
    expect(context.sources.at(-1)!.starts[0]!.slice(0,2)).toEqual([1.5,1.5]);expect(context.sources.at(-1)!.stops.at(-1)).toBe(6);
    expect(observe().positionSeconds).toBe(1.5);expect(outputGain(context).valueAt(4.5)).toBe(1);
    context.currentTime=3;mixer.apply({type:'setListeningTimer',timer:{...settings,enabled:false}});
    expect(context.sources.at(-1)!.stops).toEqual([]);expect(outputGain(context).valueAt(20)).toBe(1);
    expect(observe().positionSeconds).toBe(3);
  });
  it('accepts an elapsed deadline with a short release before automatic completion',async()=>{
    vi.useFakeTimers();const {context,mixer,observe}=create();await mixer.setScene(scene({...settings,fadeInSeconds:0}));await mixer.play();context.currentTime=2;
    mixer.apply({type:'setListeningTimer',timer:{enabled:true,durationSeconds:1,fadeInSeconds:0,fadeOutSeconds:0}});
    expect(observe().state).toBe('playing');expect(outputGain(context).valueAt(2)).toBe(1);expect(outputGain(context).valueAt(2.01)).toBeCloseTo(.5,6);
    expect(outputGain(context).valueAt(2.02)).toBe(0);
    context.currentTime=2.03;await vi.advanceTimersByTimeAsync(100);expect(observe()).toMatchObject({state:'ready',positionSeconds:1,listeningTimer:{phase:'finished'}});
  });
  it('does not replay from zero when a paused timer is edited behind its elapsed position',async()=>{
    vi.useFakeTimers();const {context,mixer,observe}=create();await mixer.setScene(scene({...settings,fadeInSeconds:0}));await mixer.play();context.currentTime=2;mixer.pause();
    mixer.apply({type:'setListeningTimer',timer:{enabled:true,durationSeconds:1,fadeInSeconds:0,fadeOutSeconds:0}});
    context.currentTime=3;await mixer.play();expect(observe()).toMatchObject({state:'playing',positionSeconds:2,listeningTimer:{remainingSeconds:0}});
    expect(context.sources).toHaveLength(1);expect(outputGain(context).valueAt(3.02)).toBe(0);
    context.currentTime=3.03;await vi.advanceTimersByTimeAsync(100);expect(observe()).toMatchObject({state:'ready',positionSeconds:1,listeningTimer:{phase:'finished'}});
  });
  it('finishes an expired edit after its release is interrupted instead of restarting the session',async()=>{
    vi.useFakeTimers();const {context,mixer,observe}=create();await mixer.setScene(scene({...settings,fadeInSeconds:0}));await mixer.play();context.currentTime=2;
    mixer.apply({type:'setListeningTimer',timer:{enabled:true,durationSeconds:1,fadeInSeconds:0,fadeOutSeconds:0}});
    context.currentTime=2.01;context.interrupt();context.currentTime=3;await mixer.play();
    expect(observe().positionSeconds).toBeCloseTo(2.01,7);expect(context.sources).toHaveLength(1);expect(outputGain(context).valueAt(3)).toBeCloseTo(.5,7);
    context.currentTime=3.03;await vi.advanceTimersByTimeAsync(100);expect(observe()).toMatchObject({state:'ready',positionSeconds:1,listeningTimer:{phase:'finished'}});
  });
  it('rejects an invalid setting without altering sources or accepted gain automation',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=.5;
    const sources=[...context.sources],events=structuredClone(outputGain(context).events);
    expect(()=>mixer.apply({type:'setListeningTimer',timer:{...settings,fadeInSeconds:4}})).toThrow();
    expect(context.sources).toEqual(sources);expect(outputGain(context).events).toEqual(events);expect(observe().positionSeconds).toBe(.5);
  });
  it('preflights replacement source allocation before a live timer duration edit',async()=>{
    const {context,mixer,observe}=create();await mixer.setScene(scene());await mixer.play();context.currentTime=.5;
    const source=context.sources[0]!,stops=[...source.stops],events=structuredClone(outputGain(context).events);
    context.createBufferSource=()=>{throw new Error('Source allocation failed');};
    expect(()=>mixer.apply({type:'setListeningTimer',timer:{...settings,durationSeconds:6}})).toThrow('Source allocation failed');
    expect(source.stops).toEqual(stops);expect(outputGain(context).events).toEqual(events);expect(observe()).toMatchObject({state:'playing',positionSeconds:.5,listeningTimer:{remainingSeconds:3.5}});
  });
  it('rolls back earlier disconnected replacements if a later layer allocation fails',async()=>{
    const {context,mixer,observe}=create();const base=scene();await mixer.setScene({...base,layers:[...base.layers,{...base.layers[0]!,id:'second'}]});await mixer.play();context.currentTime=.5;
    const accepted=[...context.sources],stops=accepted.map(source=>[...source.stops]);const make=context.createBufferSource.bind(context);let calls=0;
    context.createBufferSource=()=>{if(++calls===2)throw new Error('Later source allocation failed');return make();};
    expect(()=>mixer.apply({type:'setListeningTimer',timer:{...settings,durationSeconds:6}})).toThrow('Later source allocation failed');
    expect(accepted.map(source=>source.stops)).toEqual(stops);expect(context.sources.at(-1)!.buffer).toBeNull();expect(context.sources.at(-1)!.disconnected).toBe(true);
    expect(observe()).toMatchObject({state:'playing',positionSeconds:.5,listeningTimer:{remainingSeconds:3.5}});
  });
  it('detaches timer status for each subscriber without dirtying the saved settings',async()=>{
    const {context,mixer,observe}=create();const saved=scene();await mixer.setScene(saved);await mixer.play();context.currentTime=.5;
    mixer.subscribe(snapshot=>{if(snapshot.listeningTimer)snapshot.listeningTimer.gain=99;});
    let seen:PlaybackSnapshot['listeningTimer'];mixer.subscribe(snapshot=>{seen=snapshot.listeningTimer;});
    expect(seen!.gain).toBeCloseTo(.5,7);expect(observe().listeningTimer!.gain).toBeCloseTo(.5,7);expect(saved.listeningTimer).toEqual(settings);
  });
});
