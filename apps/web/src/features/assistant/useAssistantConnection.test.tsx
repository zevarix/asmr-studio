import {act,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {applyCommand,type AssistantDeviceState,type AssistantPendingCommand,type AssistantRegistration} from '@asmr-studio/contracts';
import {fixtureScene} from '../../../../../tests/fixtures/scene.js';
import type {AssistantHost} from './executor.js';
import {assistantApi} from './api.js';
import {useAssistantConnection} from './useAssistantConnection.js';
import {StudioApiError} from '../../api.js';

const connection:AssistantRegistration={deviceId:'browser',epoch:'epoch',browserToken:'b'.repeat(64),controlToken:'c'.repeat(64),heartbeatIntervalMs:1000,commandTimeoutMs:15000};
function host():AssistantHost {
  const state:AssistantDeviceState={scene:fixtureScene(),stateVersion:1,savedRevision:1,dirty:false,playback:{state:'paused',positionSeconds:0,error:null}};
  return {getState:()=>state,isBusy:()=>false,prepareAudio:vi.fn(async()=>{}),edit:vi.fn(async command=>{
    state.scene=applyCommand(state.scene,command);state.stateVersion++;state.dirty=true;
  }),play:vi.fn(async()=>{}),pause:vi.fn(),stop:vi.fn(),save:vi.fn(async()=>true),open:vi.fn(async()=>{}),restore:vi.fn(async()=>{})};
}
function setup(){
  vi.spyOn(assistantApi,'register').mockResolvedValue(connection);
  vi.spyOn(assistantApi,'poll').mockResolvedValue({command:null});
  vi.spyOn(assistantApi,'acknowledge').mockResolvedValue();
  vi.spyOn(assistantApi,'revoke').mockResolvedValue();
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

it('stays off until enabled and continues heartbeats while a command decodes',async()=>{
  vi.useFakeTimers();setup();const adapter=host();let finish!:()=>void;let guard!:()=>boolean;
  const edit=adapter.edit;
  adapter.edit=async(command,isCurrent)=>{guard=isCurrent;await edit(command,isCurrent);await new Promise<void>(resolve=>{finish=resolve;});};
  const command:AssistantPendingCommand={deviceId:connection.deviceId,epoch:connection.epoch,requestId:'edit-1',expectedStateVersion:1,
    action:{type:'edit',command:{type:'setMasterGain',gain:.4}},expiresAt:Date.now()+15000};
  vi.mocked(assistantApi.poll).mockResolvedValueOnce({command});
  const {result,unmount}=renderHook(()=>useAssistantConnection(adapter));
  expect(assistantApi.register).not.toHaveBeenCalled();
  await act(async()=>result.current.connect('Listening tab'));
  expect(adapter.prepareAudio).toHaveBeenCalledOnce();
  expect(result.current.connection?.deviceId).toBe(connection.deviceId);
  expect(assistantApi.acknowledge).not.toHaveBeenCalled();
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(assistantApi.poll).toHaveBeenCalledTimes(2);
  expect(guard()).toBe(true);
  act(()=>result.current.disconnect());
  expect(guard()).toBe(false);
  await act(async()=>finish());
  expect(assistantApi.acknowledge).not.toHaveBeenCalled();
  expect(assistantApi.revoke).toHaveBeenCalledExactlyOnceWith(connection);
  unmount();
});

it('revokes a registration that arrives after cancellation and never stores its keys',async()=>{
  setup();let finish!:(value:AssistantRegistration)=>void;
  vi.mocked(assistantApi.register).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const {result}=renderHook(()=>useAssistantConnection(host()));
  let pending!:Promise<void>;
  await act(async()=>{pending=result.current.connect('Tab');await Promise.resolve();});
  act(()=>result.current.disconnect());
  await act(async()=>{finish(connection);await pending;});
  expect(result.current.connection).toBeNull();
  expect(assistantApi.poll).not.toHaveBeenCalled();
  expect(assistantApi.revoke).toHaveBeenCalledWith(connection);
  expect(JSON.stringify(localStorage)).not.toContain(connection.controlToken);
  expect(JSON.stringify(sessionStorage)).not.toContain(connection.browserToken);
});

it('refreshes an overtaken heartbeat after a state conflict without revoking the connection',async()=>{
  vi.useFakeTimers();setup();
  vi.mocked(assistantApi.poll).mockRejectedValueOnce(new StudioApiError('STATE_CONFLICT',409,'A newer observation arrived first'));
  const {result,unmount}=renderHook(()=>useAssistantConnection(host()));
  await act(async()=>result.current.connect('Listening tab'));
  expect(result.current.connection).toEqual(connection);
  expect(assistantApi.revoke).not.toHaveBeenCalled();
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(assistantApi.poll).toHaveBeenCalledTimes(2);
  expect(result.current.connection).toEqual(connection);
  unmount();
});

it('serializes the next delivery behind an acknowledgement response still in flight',async()=>{
  vi.useFakeTimers();setup();const adapter=host();let acknowledged!:()=>void;
  vi.mocked(assistantApi.acknowledge).mockReturnValueOnce(new Promise(resolve=>{acknowledged=resolve;}));
  adapter.pause=vi.fn(()=>{const state=adapter.getState();state.stateVersion++;state.playback.state='paused';});
  const first:AssistantPendingCommand={deviceId:connection.deviceId,epoch:connection.epoch,requestId:'first',expectedStateVersion:1,
    action:{type:'edit',command:{type:'setMasterGain',gain:.4}},expiresAt:Date.now()+15000};
  const second:AssistantPendingCommand={...first,requestId:'second',expectedStateVersion:2,action:{type:'pause'}};
  vi.mocked(assistantApi.poll).mockResolvedValueOnce({command:first}).mockResolvedValueOnce({command:second});
  const {result,unmount}=renderHook(()=>useAssistantConnection(adapter));
  await act(async()=>result.current.connect('Tab'));
  expect(assistantApi.acknowledge).toHaveBeenCalledOnce();
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(adapter.pause).not.toHaveBeenCalled();
  await act(async()=>acknowledged());
  expect(adapter.pause).toHaveBeenCalledOnce();
  expect(assistantApi.acknowledge).toHaveBeenCalledTimes(2);
  expect(assistantApi.revoke).not.toHaveBeenCalled();
  unmount();
});
