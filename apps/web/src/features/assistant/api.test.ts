import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AssistantAcknowledgement,AssistantDeviceState,AssistantRegistration} from '@asmr-studio/contracts';
import {fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {assistantApi} from './api.js';

const connection:AssistantRegistration={deviceId:'browser',epoch:'epoch',browserToken:'b'.repeat(64),controlToken:'c'.repeat(64),heartbeatIntervalMs:1000,commandTimeoutMs:15000};
const state:AssistantDeviceState={scene:fixtureScene(),stateVersion:1,savedRevision:1,dirty:false,playback:{state:'paused',positionSeconds:0,error:null}};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('bounded browser assistant requests',()=>{
  it('aborts a lost heartbeat without retrying and releases its timer',async()=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    const fetcher=vi.fn((_url:string,options:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      signal=options.signal!;
      signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    }));
    vi.stubGlobal('fetch',fetcher);
    const result=assistantApi.poll(connection,state).catch(error=>error as unknown);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toMatchObject({code:'NETWORK_ERROR'});
    expect(signal?.aborted).toBe(true);expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires a validated receipt before treating an acknowledgement as confirmed',async()=>{
    vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({accepted:true}),{status:200})));
    const acknowledgement:AssistantAcknowledgement={epoch:connection.epoch,requestId:'edit',status:'applied',message:null,state};
    await expect(assistantApi.acknowledge(connection,acknowledgement)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
