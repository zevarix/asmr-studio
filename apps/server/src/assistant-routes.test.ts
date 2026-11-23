import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyScene,type AssistantRegistration} from '@asmr-studio/contracts';
import {openStore} from './store.js';
import {AssetStore} from './assets.js';
import {buildApp} from './app.js';
import {PlaybackDevices} from './playback-devices.js';

const origin='http://127.0.0.1:4317';
const headers={host:'127.0.0.1:4317',origin};
const state=()=>({stateVersion:0,scene:createEmptyScene('mix','Listening session'),savedRevision:null,dirty:false,
  playback:{state:'idle',positionSeconds:0,error:null}});
let root:string;let store:ReturnType<typeof openStore>;let app:ReturnType<typeof buildApp>;let devices:PlaybackDevices;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'asmr-assistant-api-'));store=openStore(join(root,'studio.sqlite'));
  const assets=new AssetStore({root:join(root,'media'),repository:store.assets,maxUploadBytes:1024,decodedBudgetBytes:1024,acceptedFormats:['wav']});
  devices=new PlaybackDevices();app=buildApp({scenes:store.scenes,assets,assistant:devices,allowedOrigin:origin});
});
afterEach(async()=>{await app.close();devices.close();store.close();rmSync(root,{recursive:true,force:true});});
async function register():Promise<AssistantRegistration> {
  const response=await app.inject({method:'POST',url:'/api/assistant/devices',headers,payload:{name:'Browser tab',state:state()}});
  expect(response.statusCode).toBe(201);return response.json();
}

describe('assistant API routes',()=>{
  it('retains the existing Host/Origin boundary and requires a separate capability for observations',async()=>{
    for(const requestHeaders of [{host:headers.host},{...headers,origin:'https://other.example'},{...headers,host:'other.example'}])
      expect((await app.inject({method:'POST',url:'/api/assistant/devices',headers:requestHeaders,payload:{name:'Browser tab',state:state()}})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url:'/api/assistant/devices',headers})).statusCode).toBe(401);
    const first=await register();await register();
    const response=await app.inject({method:'GET',url:'/api/assistant/devices',headers:{...headers,'x-asmr-control-token':first.controlToken}});
    expect(response.statusCode).toBe(200);expect(response.json().map((device:{deviceId:string})=>device.deviceId)).toEqual([first.deviceId]);
    expect(response.body).not.toContain(first.controlToken);expect(response.body).not.toContain(first.browserToken);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('delivers an edit through the selected browser and keeps the persistent scene store untouched',async()=>{
    const device=await register();const base='/api/assistant/devices/'+device.deviceId;
    const controlHeaders={...headers,'x-asmr-control-token':device.controlToken};
    const browserHeaders={...headers,'x-asmr-device-token':device.browserToken};
    const command={deviceId:device.deviceId,epoch:device.epoch,requestId:'request-1',expectedStateVersion:0,action:{type:'edit',command:{type:'setMasterGain',gain:.5}}};
    const queued=await app.inject({method:'POST',url:base+'/commands',headers:controlHeaders,payload:command});
    expect(queued.statusCode).toBe(202);expect(queued.json().status).toBe('queued');
    expect(store.scenes.list()).toEqual([]);
    const delivered=await app.inject({method:'POST',url:base+'/poll',headers:browserHeaders,payload:{epoch:device.epoch,state:state()}});
    expect(delivered.statusCode).toBe(200);expect(delivered.json().command).toMatchObject(command);
    const updated={...state(),stateVersion:1,dirty:true,scene:{...state().scene,masterGain:.5}};
    const acknowledged=await app.inject({method:'POST',url:base+'/ack',headers:browserHeaders,
      payload:{epoch:device.epoch,requestId:'request-1',status:'applied',message:null,state:updated}});
    expect(acknowledged.statusCode).toBe(200);expect(acknowledged.json()).toMatchObject({status:'applied',result:{stateVersion:1,savedRevision:null,dirty:true}});
    const result=await app.inject({method:'GET',url:base+'/commands/request-1?epoch='+device.epoch,headers:controlHeaders});
    expect(result.statusCode).toBe(200);expect(result.json()).toEqual(acknowledged.json());
    const observed=await app.inject({method:'GET',url:base+'?epoch='+device.epoch,headers:controlHeaders});
    expect(observed.json().state).toEqual(updated);expect(store.scenes.list()).toEqual([]);
  });

  it('cannot use the controller token to acknowledge, revoke, or control another device',async()=>{
    const first=await register();const second=await register();const base='/api/assistant/devices/'+first.deviceId;
    const headersWithControl={...headers,'x-asmr-control-token':first.controlToken,'x-asmr-device-token':first.controlToken};
    expect((await app.inject({method:'POST',url:base+'/poll',headers:headersWithControl,payload:{epoch:first.epoch,state:state()}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:base+'/revoke',headers:headersWithControl,payload:{epoch:first.epoch}})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/assistant/devices/'+second.deviceId+'?epoch='+second.epoch,headers:headersWithControl})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:base+'/commands',headers:{host:headers.host,'x-asmr-control-token':first.controlToken},
      payload:{deviceId:first.deviceId,epoch:first.epoch,requestId:'request-1',expectedStateVersion:0,action:{type:'stop'}}})).statusCode).toBe(403);
  });

  it('returns conflicts for reused identities and validates revocation without exposing secrets',async()=>{
    const device=await register();const base='/api/assistant/devices/'+device.deviceId;
    const controlHeaders={...headers,'x-asmr-control-token':device.controlToken};
    const command={deviceId:device.deviceId,epoch:device.epoch,requestId:'request-1',expectedStateVersion:0,action:{type:'pause'}};
    await app.inject({method:'POST',url:base+'/commands',headers:controlHeaders,payload:command});
    const changed=await app.inject({method:'POST',url:base+'/commands',headers:controlHeaders,payload:{...command,action:{type:'stop'}}});
    expect(changed.statusCode).toBe(409);expect(changed.json().code).toBe('REQUEST_ID_CONFLICT');
    const browserHeaders={...headers,'x-asmr-device-token':device.browserToken};
    expect((await app.inject({method:'POST',url:base+'/revoke',headers:browserHeaders,payload:{epoch:device.epoch,anything:true}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:base+'/revoke',headers:browserHeaders,payload:{epoch:device.epoch}})).json()).toEqual({revoked:true});
    const observed=await app.inject({method:'GET',url:base+'?epoch='+device.epoch,headers:controlHeaders});
    expect(observed.json().connected).toBe(false);
    const receipt=await app.inject({method:'GET',url:base+'/commands/request-1?epoch='+device.epoch,headers:controlHeaders});
    expect(receipt.json().status).toBe('disconnected');
  });
});
