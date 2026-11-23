import {act,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {applyCommand,parseScene,type AssistantPendingCommand,type Scene} from '@asmr-studio/contracts';
import * as audio from '@asmr-studio/audio-engine';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';
import {studioApi} from './api.js';
import {App} from './App.js';
import {MixerView,type MixerViewProps} from './features/mixer/MixerView.js';
import {useAssistantConnection} from './features/assistant/useAssistantConnection.js';
import {createAssistantExecutor} from './features/assistant/executor.js';

vi.mock('./features/mixer/MixerView.js',()=>({MixerView:vi.fn((_props:MixerViewProps)=>null)}));
vi.mock('./features/assistant/useAssistantConnection.js',()=>({useAssistantConnection:vi.fn(()=>({
  connection:null,connecting:false,message:'',connect:async()=>{},disconnect:()=>{},
}))}));

function deferred(){let resolve!:()=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fakePlayer(){
  let scene:Scene=fixtureScene();
  let snapshot:audio.PlaybackSnapshot={state:'idle',positionSeconds:0,loadedAssetIds:[],error:null};
  const listeners=new Set<(value:audio.PlaybackSnapshot)=>void>();
  const emit=(next:Partial<audio.PlaybackSnapshot>)=>{snapshot={...snapshot,...next};for(const listener of listeners)listener(snapshot);};
  const engine={setScene:vi.fn<audio.Mixer['setScene']>(async next=>{scene=next;emit({state:'ready'});}),
    updateScene:vi.fn<audio.Mixer['updateScene']>(async next=>{scene=next;}),
    apply:vi.fn<audio.Mixer['apply']>(command=>{scene=applyCommand(scene,command);}),
    play:vi.fn(async()=>{emit({state:'playing'});}),pause:vi.fn(()=>{emit({state:'paused'});}),stop:vi.fn(()=>{emit({state:'ready',positionSeconds:0});}),
    subscribe:(listener:(value:audio.PlaybackSnapshot)=>void)=>{listeners.add(listener);listener(snapshot);return()=>{listeners.delete(listener);};},
    subscribeOutput:()=>()=>{},resetOutputPeaks:vi.fn(),getDecodedAsset:vi.fn(),dispose:vi.fn(),
  } satisfies audio.Mixer;
  vi.spyOn(audio,'createMixer').mockReturnValue(engine);return engine;
}
const host=()=>vi.mocked(useAssistantConnection).mock.lastCall![0];
const view=()=>vi.mocked(MixerView).mock.lastCall![0];
const command=(requestId:string,action:AssistantPendingCommand['action']):AssistantPendingCommand=>({
  deviceId:'browser',epoch:'connection',requestId,expectedStateVersion:host().getState().stateVersion,action,expiresAt:Date.now()+15000,
});
beforeEach(()=>{
  localStorage.clear();window.history.replaceState(null,'','/?scene='+fixtureScene().id);
  vi.spyOn(studioApi,'listAssets').mockResolvedValue([fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]);
  vi.spyOn(studioApi,'listScenes').mockResolvedValue([]);
  vi.spyOn(studioApi,'getScene').mockResolvedValue(fixtureScene());
  vi.stubGlobal('AudioContext',class {state='running';async resume(){}async close(){this.state='closed';}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

async function ready(){render(<App/>);await waitFor(()=>expect(host().getState().savedRevision).toBe(1));}

describe('shared browser and assistant operations',()=>{
  it('uses the same transport and edit handlers and rejects undo after a newer UI edit',async()=>{
    const engine=fakePlayer();await ready();
    const execute=createAssistantExecutor(host);
    await act(async()=>expect((await execute(command('play',{type:'play'}),()=>true)).status).toBe('applied'));
    expect(engine.play).toHaveBeenCalledOnce();
    const edit=command('edit',{type:'edit',command:{type:'setMasterGain',gain:.3}});
    await act(async()=>expect((await execute(edit,()=>true)).status).toBe('applied'));
    expect(view().scene.masterGain).toBe(.3);
    act(()=>view().onCommand({type:'setMasterGain',gain:.5}));
    expect(engine.apply).toHaveBeenLastCalledWith({type:'setMasterGain',gain:.5});
    await act(async()=>expect(await execute(command('undo',{type:'undo',requestId:edit.requestId}),()=>true))
      .toMatchObject({status:'rejected',message:expect.stringContaining('UNDO_UNAVAILABLE')}));
    expect(view().scene.masterGain).toBe(.5);
    act(()=>view().onPause());
    expect(host().getState().playback.state).toBe('paused');
    await act(async()=>expect((await execute(command('resume',{type:'play'}),()=>true)).status).toBe('applied'));
    expect(engine.play).toHaveBeenCalledTimes(2);
  });

  it('awaits an actual graph update and reports a decoding failure with the retained draft',async()=>{
    const engine=fakePlayer();await ready();
    act(()=>view().onStart());await waitFor(()=>expect(engine.play).toHaveBeenCalledOnce());
    const pending=deferred();engine.updateScene.mockReturnValueOnce(pending.promise);
    const execute=createAssistantExecutor(host);let completed=false;
    let request!:ReturnType<typeof execute>;
    await act(async()=>{request=execute(command('add',{type:'edit',command:{type:'addLayer',layer:{...fixtureScene().layers[0]!,id:'added'}}}),()=>true)
      .then(value=>{completed=true;return value;});await Promise.resolve();});
    expect(engine.updateScene).toHaveBeenCalledOnce();expect(completed).toBe(false);
    await act(async()=>{pending.reject(new Error('Decoder rejected the file'));expect(await request).toMatchObject({status:'failed',state:{dirty:true}});});
    expect(view().scene.layers.some(layer=>layer.id==='added')).toBe(true);
    expect(host().getState().playback.state).toBe('playing');
  });

  it('invalidates a slow assistant edit when the listener pauses locally',async()=>{
    const engine=fakePlayer();await ready();act(()=>view().onStart());await waitFor(()=>expect(engine.play).toHaveBeenCalledOnce());
    const pending=deferred();let guard!:()=>boolean;
    engine.updateScene.mockImplementationOnce(async(_scene,isCurrent)=>{guard=isCurrent!;await pending.promise;if(!guard())throw new Error('Superseded');});
    const execute=createAssistantExecutor(host);let request!:ReturnType<typeof execute>;
    await act(async()=>{request=execute(command('add',{type:'edit',command:{type:'addLayer',layer:{...fixtureScene().layers[0]!,id:'added'}}}),()=>true);await Promise.resolve();});
    expect(guard()).toBe(true);act(()=>view().onPause());expect(guard()).toBe(false);
    await act(async()=>{pending.resolve();expect((await request).status).toBe('failed');});
    expect(host().getState().playback.state).toBe('paused');expect(engine.play).toHaveBeenCalledOnce();
  });

  it('preserves gesture-unlocked context across saved-session switches',async()=>{
    const engine=fakePlayer();await ready();const execute=createAssistantExecutor(host);
    await act(async()=>host().prepareAudio());
    await act(async()=>execute(command('play',{type:'play'}),()=>true));
    vi.mocked(studioApi.getScene).mockResolvedValue(parseScene({...fixtureScene(),id:'other',title:'Other session'}));
    await act(async()=>expect((await execute(command('open',{type:'openSavedSession',sceneId:'other',discardUnsaved:false}),()=>true)).status).toBe('applied'));
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(host().getState()).toMatchObject({scene:{id:'other'},playback:{audioContextState:'running',state:'idle'}});
  });

  it('bounds a browser resume that is waiting for another user gesture',async()=>{
    fakePlayer();await ready();vi.useFakeTimers();
    vi.stubGlobal('AudioContext',class {state='suspended';resume(){return new Promise<void>(()=>{});}async close(){}});
    let failure:unknown;
    let pending!:Promise<void>;
    act(()=>{pending=host().prepareAudio().catch(error=>{failure=error;});});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500);await pending;});
    expect(failure).toMatchObject({code:'NEEDS_USER_GESTURE'});
  });
});
