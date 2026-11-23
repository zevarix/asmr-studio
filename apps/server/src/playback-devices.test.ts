import {describe,expect,it} from 'vitest';
import {createEmptyScene,type AssistantDeviceState,type AssistantRegistration,type AssistantCommandRequest} from '@asmr-studio/contracts';
import {PlaybackDevices,type PlaybackDevicesOptions} from './playback-devices.js';

function state(version=0):AssistantDeviceState {
  return {stateVersion:version,scene:createEmptyScene('mix','Listening session'),savedRevision:null,dirty:false,
    playback:{state:'idle',positionSeconds:0,error:null}};
}
function setup(options:PlaybackDevicesOptions={}) {
  let now=10000;
  const broker=new PlaybackDevices({now:()=>now,leaseMs:10000,commandTimeoutMs:1000,retentionMs:60000,...options});
  const register=()=>broker.register({name:'Browser tab',state:state()});
  const command=(device:AssistantRegistration,id='request-1',version=0):AssistantCommandRequest=>({
    deviceId:device.deviceId,epoch:device.epoch,requestId:id,expectedStateVersion:version,
    action:{type:'edit',command:{type:'setMasterGain',gain:.4}},
  });
  const submit=(device:AssistantRegistration,id='request-1',version=0)=>broker.submit(device.deviceId,device.controlToken,command(device,id,version));
  const poll=(device:AssistantRegistration,report=state())=>broker.poll(device.deviceId,device.browserToken,{epoch:device.epoch,state:report});
  const receipt=(device:AssistantRegistration,id='request-1')=>broker.receipt(device.deviceId,device.epoch,id,device.controlToken);
  const view=(device:AssistantRegistration)=>broker.get(device.deviceId,device.epoch,device.controlToken);
  return {broker,register,command,submit,poll,receipt,view,advance:(milliseconds:number)=>{now+=milliseconds;},now:()=>now};
}
function rejected(action:()=>unknown,code:string,statusCode=409):void {
  try {action();throw new Error('Expected request rejection');}
  catch(error){expect(error).toMatchObject({code,statusCode});}
}

describe('selected playback device delivery',()=>{
  it('separates browser/control capabilities and reveals only the paired device',()=>{
    const h=setup();const a=h.register();const b=h.register();
    expect(a.controlToken).not.toBe(a.browserToken);
    expect(a.epoch).not.toBe(b.epoch);
    expect(h.broker.list(a.controlToken).map(device=>device.deviceId)).toEqual([a.deviceId]);
    expect(JSON.stringify(h.broker.list(a.controlToken))).not.toContain(a.controlToken);
    expect(JSON.stringify(h.view(a))).not.toContain(a.browserToken);
    rejected(()=>h.broker.list(undefined),'ASSISTANT_UNAUTHORIZED',401);
    rejected(()=>h.broker.get(b.deviceId,b.epoch,a.controlToken),'ASSISTANT_UNAUTHORIZED',401);
    rejected(()=>h.broker.submit(a.deviceId,a.browserToken,h.command(a)),'ASSISTANT_UNAUTHORIZED',401);
    rejected(()=>h.broker.poll(a.deviceId,a.controlToken,{epoch:a.epoch,state:state()}),'ASSISTANT_UNAUTHORIZED',401);
  });

  it('queues without claiming playback or saving and delivers to exactly the selected tab once',()=>{
    const h=setup();const a=h.register();const b=h.register();
    const receipt=h.submit(a);
    expect(receipt).toMatchObject({status:'queued',result:null,completedAt:null});
    expect(h.view(a).state).toEqual(state());
    expect(h.poll(b)).toEqual({command:null});
    expect(h.poll(a).command).toEqual({...h.command(a),expiresAt:receipt.expiresAt});
    expect(h.poll(a)).toEqual({command:null});
    expect(h.receipt(a).status).toBe('dispatched');
    expect(h.view(b).state).toEqual(state());
  });

  it('reconciles repeated request IDs and rejects changed payloads or simultaneous commands',()=>{
    const h=setup();const device=h.register();
    const first=h.submit(device);
    expect(h.submit(device)).toEqual(first);
    rejected(()=>h.broker.submit(device.deviceId,device.controlToken,{...h.command(device),action:{type:'stop'}}),'REQUEST_ID_CONFLICT');
    rejected(()=>h.submit(device,'request-2'),'DEVICE_BUSY');
    h.poll(device);
    expect(h.submit(device).status).toBe('dispatched');
  });

  it('checks state both before queueing and after a newer local edit reaches the browser',()=>{
    const h=setup();const device=h.register();
    rejected(()=>h.submit(device,'stale',1),'STATE_CONFLICT');
    h.submit(device);
    const newer={...state(1),scene:{...state().scene,masterGain:.7},dirty:true};
    expect(h.poll(device,newer)).toEqual({command:null});
    expect(h.receipt(device).status).toBe('rejected');
    expect(h.view(device).state).toEqual(newer);
    expect(h.submit(device,'current',1).status).toBe('queued');
  });

  it('records a reported result separately from the currently observed saved/playback state',()=>{
    const h=setup();const device=h.register();h.submit(device);h.poll(device);
    const updated={...state(1),scene:{...state().scene,masterGain:.4},dirty:true,
      playback:{state:'playing' as const,positionSeconds:4,error:null}};
    const receipt=h.broker.acknowledge(device.deviceId,device.browserToken,{epoch:device.epoch,requestId:'request-1',status:'applied',message:null,state:updated});
    expect(receipt).toMatchObject({status:'applied',result:{stateVersion:1,savedRevision:null,dirty:true,playback:updated.playback}});
    expect(receipt.result).not.toHaveProperty('scene');
    expect(h.view(device).state).toEqual(updated);
    expect(h.submit(device)).toEqual(receipt);
  });

  it('retains an exact acknowledgement retry without overwriting newer UI edits',()=>{
    const h=setup();const device=h.register();h.submit(device);h.poll(device);
    const acknowledgement={epoch:device.epoch,requestId:'request-1',status:'applied' as const,message:null,state:{...state(1),dirty:true}};
    const first=h.broker.acknowledge(device.deviceId,device.browserToken,acknowledgement);
    const newer={...state(2),scene:{...state().scene,title:'Later local edit'},dirty:true};
    h.poll(device,newer);
    expect(h.broker.acknowledge(device.deviceId,device.browserToken,acknowledgement)).toEqual(first);
    expect(h.view(device).state).toEqual(newer);
    rejected(()=>h.broker.acknowledge(device.deviceId,device.browserToken,{...acknowledgement,message:'Changed result'}),'ACKNOWLEDGEMENT_CONFLICT');
  });

  it('does not permit a stale acknowledgement to backdate a newer observation',()=>{
    const h=setup();const device=h.register();h.submit(device);h.poll(device);
    h.poll(device,state(2));
    rejected(()=>h.broker.acknowledge(device.deviceId,device.browserToken,{epoch:device.epoch,requestId:'request-1',status:'applied',message:null,state:state(1)}),'STALE_ACKNOWLEDGEMENT');
    expect(h.view(device).state.stateVersion).toBe(2);
    expect(h.receipt(device).status).toBe('dispatched');
  });

  it('reports a failed audio application without pretending the changed draft was saved',()=>{
    const h=setup();const device=h.register();h.submit(device);h.poll(device);
    const failed={...state(1),scene:{...state().scene,masterGain:.4},dirty:true,
      playback:{state:'error' as const,positionSeconds:0,error:'The recording could not be decoded'}};
    const result=h.broker.acknowledge(device.deviceId,device.browserToken,{epoch:device.epoch,requestId:'request-1',status:'failed',message:'Audio update failed',state:failed});
    expect(result.status).toBe('failed');expect(result.result?.savedRevision).toBeNull();expect(result.result?.dirty).toBe(true);
    expect(h.view(device).state.scene.masterGain).toBe(.4);
  });

  it('distinguishes an undelivered expiry from a dispatched command with an unknown outcome',()=>{
    const h=setup();const queued=h.register();const dispatched=h.register();
    h.submit(queued);h.submit(dispatched);h.poll(dispatched);
    h.advance(1000);
    expect(h.receipt(queued).status).toBe('expired');
    expect(h.receipt(dispatched)).toMatchObject({status:'unconfirmed',result:null});
    expect(h.poll(queued)).toEqual({command:null});expect(h.poll(dispatched)).toEqual({command:null});
    expect(h.submit(dispatched).status).toBe('unconfirmed');
    rejected(()=>h.broker.acknowledge(dispatched.deviceId,dispatched.browserToken,{epoch:dispatched.epoch,requestId:'request-1',status:'applied',message:null,state:state(1)}),'ACKNOWLEDGEMENT_EXPIRED',410);
    expect(h.view(dispatched).state.stateVersion).toBe(0);
  });

  it('never revives an expired connection or replays its queued commands after reconnect',()=>{
    const h=setup({leaseMs:100,commandTimeoutMs:1000});const device=h.register();h.submit(device);
    h.advance(100);
    expect(h.view(device).connected).toBe(false);expect(h.receipt(device).status).toBe('disconnected');
    rejected(()=>h.poll(device),'DEVICE_DISCONNECTED',410);
    rejected(()=>h.submit(device,'new'),'DEVICE_DISCONNECTED',410);
    const next=h.register();expect(next.epoch).not.toBe(device.epoch);expect(next.controlToken).not.toBe(device.controlToken);
    expect(h.poll(next)).toEqual({command:null});
    expect(h.submit(device).status).toBe('disconnected');
  });

  it('revocation leaves a dispatched result unconfirmed and prevents new delivery',()=>{
    const h=setup();const device=h.register();h.submit(device);h.poll(device);
    expect(h.broker.revoke(device.deviceId,device.epoch,device.browserToken)).toEqual({revoked:true});
    expect(h.broker.revoke(device.deviceId,device.epoch,device.browserToken)).toEqual({revoked:true});
    expect(h.view(device).connected).toBe(false);expect(h.receipt(device).status).toBe('unconfirmed');
    rejected(()=>h.poll(device),'DEVICE_DISCONNECTED',410);
  });

  it('requires the exact epoch, path identity, and a genuinely dispatched command',()=>{
    const h=setup();const device=h.register();
    rejected(()=>h.broker.get(device.deviceId,'older-epoch',device.controlToken),'CONNECTION_CONFLICT');
    rejected(()=>h.broker.submit(device.deviceId,device.controlToken,{...h.command(device),deviceId:'another-device'}),'DEVICE_MISMATCH');
    h.submit(device);
    const acknowledgement={epoch:device.epoch,requestId:'request-1',status:'applied',message:null,state:state(1)};
    rejected(()=>h.broker.acknowledge(device.deviceId,device.browserToken,acknowledgement),'ACKNOWLEDGEMENT_CONFLICT');
    h.poll(device);
    rejected(()=>h.broker.acknowledge(device.deviceId,device.browserToken,{...acknowledgement,state:state()}),'INVALID_ACKNOWLEDGEMENT');
    rejected(()=>h.broker.acknowledge(device.deviceId,device.browserToken,{...acknowledgement,requestId:'missing'}),'COMMAND_NOT_FOUND',404);
  });

  it('allows playback clock observations but rejects regressing or conflicting draft versions',()=>{
    const h=setup();const device=h.register();
    h.poll(device,{...state(2),playback:{state:'playing',positionSeconds:2,error:null}});
    h.advance(10);
    h.poll(device,{...state(2),playback:{state:'playing',positionSeconds:3,error:null}});
    expect(h.view(device).state.playback.positionSeconds).toBe(3);
    rejected(()=>h.poll(device,state(1)),'STATE_CONFLICT');
    rejected(()=>h.poll(device,{...state(2),scene:{...state().scene,title:'Changed without version'}}),'STATE_CONFLICT');
    expect(h.view(device).state.scene.title).toBe('Listening session');
  });

  it('bounds command retention without forgetting IDs that could accidentally replay',()=>{
    const h=setup({maxCommandsPerDevice:1});const device=h.register();h.submit(device);h.poll(device);
    h.broker.acknowledge(device.deviceId,device.browserToken,{epoch:device.epoch,requestId:'request-1',status:'rejected',message:'No change',state:state()});
    rejected(()=>h.submit(device,'second'),'COMMAND_LIMIT',429);
    expect(h.submit(device).status).toBe('rejected');
  });

  it('bounds devices and removes only inactive connections after the retention window',()=>{
    const h=setup({maxDevices:2,leaseMs:100,retentionMs:200});const old=h.register();const active=h.register();
    rejected(()=>h.register(),'DEVICE_LIMIT',429);
    h.advance(90);h.poll(active);h.advance(90);h.poll(active);h.advance(20);
    const next=h.register();expect(next.deviceId).not.toBe(old.deviceId);
    rejected(()=>h.view(old),'ASSISTANT_UNAUTHORIZED',401);
    expect(h.view(active).connected).toBe(true);
  });

  it('does not expose mutable registry state through results and drops tokens on close',()=>{
    const h=setup();const device=h.register();const observed=h.view(device);observed.state.scene.title='Mutated caller object';
    expect(h.view(device).state.scene.title).toBe('Listening session');
    const queued=h.submit(device);queued.status='applied';expect(h.receipt(device).status).toBe('queued');
    const delivered=h.poll(device).command!;delivered.action={type:'stop'};
    expect(h.submit(device).status).toBe('dispatched');
    h.broker.close();rejected(()=>h.view(device),'ASSISTANT_UNAUTHORIZED',401);
  });

  it('rejects invalid runtime bounds',()=>{
    for(const maxDevices of [0,-1,1.5,Infinity])expect(()=>new PlaybackDevices({maxDevices})).toThrow();
  });
});
