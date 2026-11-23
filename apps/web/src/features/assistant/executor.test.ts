import {afterEach,describe,expect,it,vi} from 'vitest';
import {applyCommand,parseScene,type AssistantDeviceState,type AssistantPendingCommand} from '@asmr-studio/contracts';
import {fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {AssistantControlError,createAssistantExecutor,type AssistantHost} from './executor.js';

function setup(){
  let state:AssistantDeviceState={scene:fixtureScene(),stateVersion:3,savedRevision:1,dirty:false,
    playback:{state:'paused',positionSeconds:2,error:null,audioContextState:'running'}};
  const host:AssistantHost={getState:()=>state,isBusy:()=>false,prepareAudio:async()=>{},
    edit:vi.fn(async command=>{state={...state,scene:applyCommand(state.scene,command),stateVersion:state.stateVersion+1,dirty:true};}),
    play:vi.fn(async()=>{state={...state,stateVersion:state.stateVersion+1,playback:{...state.playback,state:'playing'}};}),
    pause:vi.fn(()=>{state={...state,stateVersion:state.stateVersion+1,playback:{...state.playback,state:'paused'}};}),
    stop:vi.fn(()=>{state={...state,stateVersion:state.stateVersion+1,playback:{...state.playback,state:'ready',positionSeconds:0}};}),
    save:vi.fn(async()=>{state={...state,stateVersion:state.stateVersion+1,savedRevision:2,dirty:false,scene:parseScene({...state.scene,revision:2})};return true;}),
    open:vi.fn(async()=>{}),restore:vi.fn(async scene=>{state={...state,scene,stateVersion:state.stateVersion+1,dirty:false};}),
  };
  let sequence=0;
  const command=(action:AssistantPendingCommand['action'],overrides:Partial<AssistantPendingCommand>={}):AssistantPendingCommand=>({
    deviceId:'browser-one',epoch:'connection-one',requestId:'request-'+(++sequence),expectedStateVersion:state.stateVersion,
    expiresAt:Date.now()+15000,action,...overrides,
  });
  return {host,command,execute:createAssistantExecutor(()=>host),change:(next:Partial<AssistantDeviceState>)=>{state={...state,...next};}};
}
function deferred(){let resolve!:()=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
afterEach(()=>vi.useRealTimers());

describe('assistant command execution',()=>{
  it('waits for graph completion and keeps a failed draft distinct from applied playback',async()=>{
    const {host,command,execute}=setup();const pending=deferred();
    const edit=host.edit;
    host.edit=vi.fn(async(...args:Parameters<AssistantHost['edit']>)=>{await edit(...args);await pending.promise;});
    let completed=false;
    const result=execute(command({type:'edit',command:{type:'setMasterGain',gain:.4}}),()=>true).then(value=>{completed=true;return value;});
    await Promise.resolve();expect(completed).toBe(false);
    expect(host.getState()).toMatchObject({stateVersion:4,dirty:true,scene:{masterGain:.4}});
    pending.reject(new Error('Decode failed'));
    expect(await result).toMatchObject({status:'failed',message:expect.stringContaining('APPLY_FAILED'),state:{stateVersion:4,dirty:true}});
  });

  it('rejects stale requests before invoking any operation',async()=>{
    const {host,command,execute}=setup();
    expect(await execute(command({type:'play'},{expectedStateVersion:2}),()=>true)).toMatchObject({status:'rejected',message:expect.stringContaining('STALE_STATE')});
    expect(host.play).not.toHaveBeenCalled();
  });

  it('does not acknowledge an earlier edit as applied after a newer local change',async()=>{
    const {host,command,execute,change}=setup();const pending=deferred();const edit=host.edit;
    host.edit=async(...args:Parameters<AssistantHost['edit']>)=>{await edit(...args);await pending.promise;};
    const result=execute(command({type:'edit',command:{type:'setMasterGain',gain:.4}}),()=>true);
    await Promise.resolve();change({stateVersion:5,scene:parseScene({...host.getState().scene,title:'Newer local title'})});
    pending.resolve();
    expect(await result).toMatchObject({status:'failed',message:expect.stringContaining('SUPERSEDED'),state:{scene:{title:'Newer local title'}}});
  });

  it('reports the user-gesture requirement and verifies actual playback rather than promise resolution',async()=>{
    const {host,command,execute,change}=setup();
    host.play=async()=>{throw new AssistantControlError('NEEDS_USER_GESTURE','Start listening in this browser.');};
    expect(await execute(command({type:'play'}),()=>true)).toMatchObject({status:'failed',message:expect.stringContaining('NEEDS_USER_GESTURE')});
    host.play=async()=>{change({stateVersion:4});};
    expect(await execute(command({type:'play'}),()=>true)).toMatchObject({status:'failed',message:expect.stringContaining('NEEDS_USER_GESTURE')});
  });

  it('allows one immediate edit undo and refuses undo after newer local changes',async()=>{
    const {host,command,execute,change}=setup();const original=host.getState().scene;
    const first=command({type:'edit',command:{type:'setMasterGain',gain:.4}});
    expect((await execute(first,()=>true)).status).toBe('applied');
    expect((await execute(command({type:'undo',requestId:first.requestId}),()=>true)).status).toBe('applied');
    expect(host.getState().scene).toEqual(original);
    const second=command({type:'edit',command:{type:'setMasterGain',gain:.6}});
    await execute(second,()=>true);change({stateVersion:host.getState().stateVersion+1});
    expect(await execute(command({type:'undo',requestId:second.requestId}),()=>true)).toMatchObject({status:'rejected',message:expect.stringContaining('UNDO_UNAVAILABLE')});
    expect(host.getState().scene.masterGain).toBe(.6);
  });

  it('requires explicit discard intent for a dirty session and does not replay duplicate requests',async()=>{
    const {host,command,execute,change}=setup();change({dirty:true});
    expect(await execute(command({type:'openSavedSession',sceneId:'other',discardUnsaved:false}),()=>true))
      .toMatchObject({status:'rejected',message:expect.stringContaining('UNSAVED_CHANGES')});
    expect(host.open).not.toHaveBeenCalled();
    const pause=command({type:'pause'});await execute(pause,()=>true);
    expect((await execute(pause,()=>true)).status).toBe('rejected');
    expect(host.pause).toHaveBeenCalledOnce();
  });

  it('bounds a stalled operation and makes its late application guard false',async()=>{
    vi.useFakeTimers();const {host,command,execute}=setup();let guard!:()=>boolean;
    host.edit=async(_command,isCurrent)=>{guard=isCurrent;await new Promise(()=>{});};
    const result=execute(command({type:'edit',command:{type:'setMasterGain',gain:.2}},{expiresAt:Date.now()+100}),()=>true);
    expect(guard()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({status:'failed',message:expect.stringContaining('EXPIRED')});
    expect(guard()).toBe(false);
  });

  it('keeps save failure separate from transport success',async()=>{
    const {host,command,execute}=setup();host.save=async()=>false;
    expect(await execute(command({type:'save'}),()=>true)).toMatchObject({status:'failed',message:expect.stringContaining('SAVE_INCOMPLETE')});
    expect((await execute(command({type:'play'}),()=>true)).state.playback.state).toBe('playing');
    expect((await execute(command({type:'pause'}),()=>true)).state.playback.state).toBe('paused');
    expect((await execute(command({type:'stop'}),()=>true)).state.playback).toMatchObject({state:'ready',positionSeconds:0});
  });
});
