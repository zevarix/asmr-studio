import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {applyCommand,createEmptyTransition,parseCapturedMix,parseScene,type Scene} from '@asmr-studio/contracts';
import * as audio from '@asmr-studio/audio-engine';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';
import {studioApi} from './api.js';
import {App} from './App.js';

function deferred<T>() {
  let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const assets=[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}];
const captureA=parseCapturedMix({id:'capture-a',scene:fixtureScene(),assets});
const captureB=parseCapturedMix({id:'capture-b',scene:{...fixtureScene(),id:'source-b',title:'Evening rain',revision:7},assets});
const captureC=parseCapturedMix({id:'capture-c',scene:{...fixtureScene(),id:'source-c',title:'Night rain',revision:2},assets});
function arrangement():Scene {
  const empty=createEmptyTransition('arrangement','Rain transition');
  return parseScene({...empty,revision:1,transition:{...empty.transition!,a:captureA}});
}

function fakePlayer(){
  let loaded:Scene=arrangement();
  let snapshot:audio.PlaybackSnapshot={state:'idle',positionSeconds:0,loadedAssetIds:[],error:null};
  let sampled:audio.PlaybackSnapshot|null=null;
  const listeners=new Set<(value:audio.PlaybackSnapshot)=>void>();
  const emit=(update:Partial<audio.PlaybackSnapshot>)=>{snapshot={...snapshot,...update};for(const listener of listeners)listener(snapshot);};
  const engine={
    setScene:vi.fn<audio.Mixer['setScene']>(async scene=>{loaded=scene;emit({state:'ready'});}),
    updateScene:vi.fn<audio.Mixer['updateScene']>(async scene=>{loaded=scene;emit({error:null});}),
    apply:vi.fn<audio.Mixer['apply']>(command=>{loaded=applyCommand(loaded,command);}),
    play:vi.fn(async()=>{emit({state:'playing'});}),pause:vi.fn(()=>{emit({state:'paused'});}),stop:vi.fn(()=>{emit({state:'ready',positionSeconds:0});}),
    subscribe:(listener:(value:audio.PlaybackSnapshot)=>void)=>{listeners.add(listener);listener(sampled??snapshot);return()=>{listeners.delete(listener);};},
    subscribeOutput:()=>()=>{},resetOutputPeaks:vi.fn(),getDecodedAsset:vi.fn(),dispose:vi.fn(),
  } satisfies audio.Mixer;
  vi.spyOn(audio,'createMixer').mockReturnValue(engine);
  return {engine,emit,sample:(value:audio.PlaybackSnapshot)=>{sampled=value;}};
}

beforeEach(()=>{
  localStorage.clear();window.history.replaceState(null,'','/?scene=arrangement');
  vi.spyOn(studioApi,'listAssets').mockResolvedValue(assets);
  vi.spyOn(studioApi,'listStarterSounds').mockResolvedValue([]);
  vi.spyOn(studioApi,'listScenes').mockResolvedValue([
    {id:'arrangement',title:'Rain transition',kind:'transition',revision:1,durationSeconds:null,layerCount:2},
    {id:captureA.scene.id,title:captureA.scene.title,kind:'mix',revision:1,durationSeconds:null,layerCount:2},
    {id:captureB.scene.id,title:captureB.scene.title,kind:'mix',revision:1,durationSeconds:null,layerCount:2},
    {id:captureC.scene.id,title:captureC.scene.title,kind:'mix',revision:2,durationSeconds:null,layerCount:2},
  ]);
  vi.spyOn(studioApi,'getScene').mockImplementation(async id=>id==='arrangement'?arrangement():id===captureB.scene.id?captureB.scene:captureC.scene);
  vi.spyOn(studioApi,'captureScene').mockImplementation(async id=>id===captureB.scene.id?captureB:captureC);
  vi.spyOn(studioApi,'saveScene').mockImplementation(async scene=>parseScene({...scene,revision:scene.revision+1}));
  vi.stubGlobal('AudioContext',class {async resume(){} async close(){}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

async function openStarted(){
  render(<App/>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Start listening'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Start listening'}));
  await waitFor(()=>expect(within(screen.getByRole('region',{name:'Playback controls'})).getByRole('status')).toHaveTextContent('Playing'));
}

describe('transition source transactions',()=>{
  it('keeps A pausable/resumable during B preparation and leaves the saved draft intact when B fails',async()=>{
    const {engine}=fakePlayer();
    const pending=deferred<void>();engine.updateScene.mockReturnValueOnce(pending.promise);
    await openStarted();
    fireEvent.change(screen.getByRole('combobox',{name:'Choose mix B'}),{target:{value:captureB.scene.id}});
    await waitFor(()=>expect(engine.updateScene).toHaveBeenCalledOnce());
    expect(studioApi.captureScene).toHaveBeenCalledExactlyOnceWith(captureB.scene.id,7);
    expect(screen.getByRole('button',{name:'Save arrangement'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();
    expect(screen.getByRole('slider',{name:'Master volume'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'Pause'}));
    fireEvent.click(screen.getByRole('button',{name:'Start listening'}));
    await waitFor(()=>expect(engine.play).toHaveBeenCalledTimes(2));
    await act(async()=>pending.reject(new Error('Unavailable B audio')));
    expect(within(screen.getByRole('region',{name:'Mix B'})).getByRole('alert')).toHaveTextContent('current audio are still here');
    expect(within(screen.getByRole('region',{name:'Mix A'})).getByText('Captured revision 1')).toBeVisible();
    expect(screen.getByRole('combobox',{name:'Choose mix B'})).toHaveValue('');
    fireEvent.click(screen.getByRole('button',{name:'Save arrangement'}));
    await waitFor(()=>expect(studioApi.saveScene).toHaveBeenCalledWith(expect.objectContaining({transition:expect.objectContaining({a:captureA,b:null})}),1));
  });

  it('supersedes an obsolete B preparation before committing the latest capture',async()=>{
    const {engine}=fakePlayer();const older=deferred<void>();
    engine.updateScene.mockReturnValueOnce(older.promise);
    await openStarted();
    fireEvent.change(screen.getByRole('combobox',{name:'Choose mix B'}),{target:{value:captureB.scene.id}});
    await waitFor(()=>expect(engine.updateScene).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('combobox',{name:'Choose mix B'}),{target:{value:captureC.scene.id}});
    await waitFor(()=>expect(within(screen.getByRole('region',{name:'Mix B'})).getByText('Captured revision 2')).toBeVisible());
    expect(engine.updateScene.mock.calls[1]![0].transition!.b).toBeNull();
    await act(async()=>older.resolve());
    expect(screen.getByRole('combobox',{name:'Choose mix B'})).toHaveValue(captureC.scene.id);
    fireEvent.click(screen.getByRole('button',{name:'Save arrangement'}));
    await waitFor(()=>expect(studioApi.saveScene).toHaveBeenCalledWith(expect.objectContaining({transition:expect.objectContaining({b:captureC})}),1));
  });

  it('cancels at the freshly sampled audio-clock blend instead of the last display tick',async()=>{
    const {engine,emit,sample}=fakePlayer();
    const complete=arrangement();complete.transition!.b=captureB;complete.transition!.mode='timed';
    vi.mocked(studioApi.getScene).mockResolvedValue(complete);
    await openStarted();
    act(()=>emit({positionSeconds:10,transition:{blend:.3,phase:'running',remainingSeconds:20}}));
    sample({state:'playing',positionSeconds:10.08,loadedAssetIds:[],error:null,transition:{blend:.643,phase:'running',remainingSeconds:19.92}});
    fireEvent.click(screen.getByRole('button',{name:'Cancel transition'}));
    expect(engine.apply).toHaveBeenCalledWith({type:'setTransition',transition:expect.objectContaining({mode:'manual',blend:.643,startSeconds:0})});
  });

  it('starts a timed move from the selected manual target before the first Start',async()=>{
    const {engine,sample}=fakePlayer();
    render(<App/>);
    await waitFor(()=>expect(screen.getByRole('combobox',{name:'Choose mix B'})).toBeEnabled());
    fireEvent.change(screen.getByRole('combobox',{name:'Choose mix B'}),{target:{value:captureB.scene.id}});
    await waitFor(()=>expect(within(screen.getByRole('region',{name:'Mix B'})).getByText('Captured revision 7')).toBeVisible());
    expect(engine.play).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('slider',{name:'Crossfader'}),{target:{value:'35'}});
    sample({state:'ready',positionSeconds:0,loadedAssetIds:[],error:null,transition:{blend:0,phase:'manual',remainingSeconds:0}});
    fireEvent.click(screen.getByRole('button',{name:'Transition to B in 30 seconds'}));
    expect(engine.apply).toHaveBeenLastCalledWith({type:'setTransition',transition:expect.objectContaining({mode:'timed',blend:.35,startSeconds:0})});
    await waitFor(()=>expect(engine.play).toHaveBeenCalledOnce());
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('uses a paused manual edit as the timed starting blend while retaining the paused playhead',async()=>{
    const {engine,emit}=fakePlayer();
    const complete=arrangement();complete.transition!.b=captureB;
    vi.mocked(studioApi.getScene).mockResolvedValue(complete);
    await openStarted();
    act(()=>emit({positionSeconds:12,transition:{blend:0,phase:'manual',remainingSeconds:0}}));
    fireEvent.click(screen.getByRole('button',{name:'Pause'}));
    fireEvent.change(screen.getByRole('slider',{name:'Crossfader'}),{target:{value:'35'}});
    fireEvent.click(screen.getByRole('button',{name:'Transition to B in 30 seconds'}));
    expect(engine.apply).toHaveBeenLastCalledWith({type:'setTransition',transition:expect.objectContaining({mode:'timed',blend:.35,startSeconds:12})});
    await waitFor(()=>expect(engine.play).toHaveBeenCalledTimes(2));
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('keeps the exact held audio blend when starting another timed move from timed pause',async()=>{
    const {engine,emit,sample}=fakePlayer();
    const complete=arrangement();complete.transition!.b=captureB;complete.transition!.mode='timed';complete.transition!.blend=.15;
    vi.mocked(studioApi.getScene).mockResolvedValue(complete);
    await openStarted();
    act(()=>emit({positionSeconds:12,transition:{blend:.35,phase:'running',remainingSeconds:18}}));
    fireEvent.click(screen.getByRole('button',{name:'Pause'}));
    sample({state:'paused',positionSeconds:12.08,loadedAssetIds:[],error:null,transition:{blend:.643,phase:'running',remainingSeconds:17.92}});
    fireEvent.click(screen.getByRole('button',{name:'Transition to B in 30 seconds'}));
    expect(engine.apply).toHaveBeenLastCalledWith({type:'setTransition',transition:expect.objectContaining({mode:'timed',blend:.643,startSeconds:12.08})});
    await waitFor(()=>expect(engine.play).toHaveBeenCalledTimes(2));
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('uses the current audible blend when a playing manual edit is still smoothing',async()=>{
    const {engine,sample}=fakePlayer();
    const complete=arrangement();complete.transition!.b=captureB;complete.transition!.blend=.35;
    vi.mocked(studioApi.getScene).mockResolvedValue(complete);
    await openStarted();
    sample({state:'playing',positionSeconds:8.01,loadedAssetIds:[],error:null,transition:{blend:.31,phase:'manual',remainingSeconds:0}});
    fireEvent.click(screen.getByRole('button',{name:'Transition to B in 30 seconds'}));
    expect(engine.apply).toHaveBeenLastCalledWith({type:'setTransition',transition:expect.objectContaining({mode:'timed',blend:.31,startSeconds:8.01})});
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('rewinds a naturally completed arrangement before scheduling a new timed move',async()=>{
    const {engine,emit}=fakePlayer();
    const complete=arrangement();complete.transition!.b=captureB;complete.transition!.blend=.35;
    vi.mocked(studioApi.getScene).mockResolvedValue(complete);
    await openStarted();
    act(()=>emit({state:'ready',positionSeconds:2,transition:{blend:.35,phase:'manual',remainingSeconds:0}}));
    fireEvent.click(screen.getByRole('button',{name:'Transition to B in 30 seconds'}));
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(engine.apply).toHaveBeenLastCalledWith({type:'setTransition',transition:expect.objectContaining({mode:'timed',blend:.35,startSeconds:0})});
    expect(engine.stop.mock.invocationCallOrder[0]!).toBeLessThan(engine.apply.mock.invocationCallOrder[0]!);
    await waitFor(()=>expect(engine.play).toHaveBeenCalledTimes(2));
  });
});
