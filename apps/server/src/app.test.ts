import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore} from './store.js';import {AssetStore} from './assets.js';import {buildApp} from './app.js';
import {createEmptyScene,createEmptyTransition} from '@asmr-studio/contracts';import {fixtureAsset,fixtureLayer} from '../../../tests/fixtures/scene.js';import {wavFixture} from '../../../tests/fixtures/audio.js';
let root:string;let store:ReturnType<typeof openStore>;let app:ReturnType<typeof buildApp>;
const origin='http://127.0.0.1:4317';const headers={host:'127.0.0.1:4317',origin};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'asmr-api-'));store=openStore(join(root,'studio.sqlite'));const assets=new AssetStore({root:join(root,'media'),repository:store.assets,maxUploadBytes:1024*1024,decodedBudgetBytes:1024*1024,acceptedFormats:['wav']});app=buildApp({scenes:store.scenes,assets,allowedOrigin:origin});});
afterEach(async()=>{await app.close();store.close();rmSync(root,{recursive:true,force:true});});
function metadata(){const {id,sha256,durationSeconds,sampleRate,channels,format,...data}=fixtureAsset();return data;}

describe('loopback API',()=>{
  it('creates reads and updates with a conflict-safe revision envelope',async()=>{
    expect((await app.inject({method:'GET',url:'/api/health',headers})).statusCode).toBe(200);
    const created=await app.inject({method:'POST',url:'/api/scenes',headers,payload:createEmptyScene('scene-1','Test')});expect(created.statusCode).toBe(201);const scene=created.json();expect(scene.revision).toBe(1);
    const saved=await app.inject({method:'PUT',url:'/api/scenes/scene-1',headers,payload:{expectedRevision:1,scene:{...scene,title:'Saved'}}});expect(saved.statusCode).toBe(200);expect(saved.json().revision).toBe(2);
    const rejected=await app.inject({method:'PUT',url:'/api/scenes/scene-1',headers,payload:{expectedRevision:1,scene:{...scene,title:'Stale'}}});expect(rejected.statusCode).toBe(409);expect(rejected.json().currentRevision).toBe(2);
    const current=await app.inject({method:'GET',url:'/api/scenes/scene-1',headers});expect(current.json().title).toBe('Saved');
    const list=await app.inject({method:'GET',url:'/api/scenes',headers});
    expect(list.json()).toEqual([{id:'scene-1',title:'Saved',revision:2,durationSeconds:null,layerCount:0,kind:'mix'}]);
    const wrong=await app.inject({method:'PUT',url:'/api/scenes/other',headers,payload:{expectedRevision:2,scene:saved.json()}});expect(wrong.statusCode).toBe(400);
  });
  it('streams an upload with explicit metadata and serves range requests',async()=>{
    const file=wavFixture();const response=await app.inject({method:'POST',url:'/api/assets',headers:{...headers,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify(metadata())},payload:Buffer.from(file)});
    expect(response.statusCode).toBe(201);const asset=response.json();expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    const library=await app.inject({method:'GET',url:'/api/assets',headers});expect(library.json()).toEqual([asset]);
    const range=await app.inject({method:'GET',url:`/api/assets/${asset.id}/content`,headers:{...headers,range:'bytes=0-3'}});expect(range.statusCode).toBe(206);expect(range.headers['content-range']).toBe(`bytes 0-3/${file.length}`);expect(range.rawPayload).toEqual(Buffer.from('RIFF'));
    const suffix=await app.inject({method:'GET',url:`/api/assets/${asset.id}/content`,headers:{...headers,range:'bytes=-4'}});expect(suffix.statusCode).toBe(206);expect(suffix.rawPayload).toEqual(Buffer.from(file.slice(-4)));
    const invalid=await app.inject({method:'GET',url:`/api/assets/${asset.id}/content`,headers:{...headers,range:'bytes=999999-'}});expect(invalid.statusCode).toBe(416);
    const scene={...createEmptyScene('with-audio','Test'),layers:[{...fixtureLayer(),assetId:asset.id}]};expect((await app.inject({method:'POST',url:'/api/scenes',headers,payload:scene})).statusCode).toBe(201);
  });
  it('captures only the exact canonical saved revision through the same-origin boundary',async()=>{
    const scene=store.scenes.create(createEmptyScene('source','Saved source'));
    const url='/api/scenes/source/capture';
    for(const payload of [{},{expectedRevision:0},{expectedRevision:1,scene},{expectedRevision:'1'}]){
      expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
    }
    expect((await app.inject({method:'POST',url,headers:{...headers,'content-type':'application/json'},payload:'null'})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url,headers:{host:headers.host},payload:{expectedRevision:1}})).statusCode).toBe(403);
    const response=await app.inject({method:'POST',url,headers,payload:{expectedRevision:1}});
    expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({scene,assets:[]});
    expect(response.json().id).toEqual(expect.any(String));
    store.scenes.save({...scene,title:'Later'},1);
    const stale=await app.inject({method:'POST',url,headers,payload:{expectedRevision:1}});
    expect(stale.statusCode).toBe(409);expect(stale.json().currentRevision).toBe(2);
    expect((await app.inject({method:'POST',url:'/api/scenes/missing/capture',headers,payload:{expectedRevision:1}})).statusCode).toBe(404);
    store.scenes.create(createEmptyTransition('transition','Transition'));
    expect((await app.inject({method:'POST',url:'/api/scenes/transition/capture',headers,payload:{expectedRevision:1}})).statusCode).toBe(400);
  });
  it('rejects hostile host/origin and missing mutation origin without effects',async()=>{
    for(const requestHeaders of [{host:'attacker.example',origin},{host:headers.host,origin:'https://attacker.example'},{host:headers.host},{host:headers.host,origin:'null'}]) {
      const r=await app.inject({method:'POST',url:'/api/scenes',headers:requestHeaders,payload:createEmptyScene('bad','Test')});expect(r.statusCode).toBe(403);
    }
    expect(store.scenes.get('bad')).toBeNull();
    const r=await app.inject({method:'GET',url:'/api/assets',headers:{host:'attacker.example'}});expect(r.statusCode).toBe(403);
  });
  it('installs only the fixed starter catalog through the same-origin boundary',async()=>{
    await app.close();
    const assets=new AssetStore({root:join(root,'media'),repository:store.assets,maxUploadBytes:1024*1024,decodedBudgetBytes:1024*1024,acceptedFormats:['wav']});
    let installations=0;
    app=buildApp({scenes:store.scenes,assets,allowedOrigin:origin,starterLibrary:{
      catalog:()=>[{id:'rain',assetId:null}],
      install:async()=>{installations++;return [fixtureAsset()];},
    }});
    expect((await app.inject({method:'GET',url:'/api/library',headers})).json()).toEqual([{id:'rain',assetId:null}]);
    expect((await app.inject({method:'POST',url:'/api/library/install',headers,payload:{url:'https://example.com/custom.wav'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/library/install',headers:{...headers,origin:'https://attacker.example'},payload:{}})).statusCode).toBe(403);
    expect(installations).toBe(0);
    const installed=await app.inject({method:'POST',url:'/api/library/install',headers,payload:{}});
    expect(installed.statusCode).toBe(200);expect(installed.json()).toEqual([fixtureAsset()]);expect(installations).toBe(1);
  });
  it('rejects missing assets malformed payloads and corrupt uploads without success-shaped responses',async()=>{
    const absent=await app.inject({method:'POST',url:'/api/scenes',headers,payload:{...createEmptyScene('bad','Test'),layers:[fixtureLayer()]}});expect(absent.statusCode).toBe(422);
    const future=await app.inject({method:'POST',url:'/api/scenes',headers,payload:{...createEmptyScene('future','Test'),schemaVersion:2}});expect(future.statusCode).toBe(400);
    const corrupt=await app.inject({method:'POST',url:'/api/assets',headers:{...headers,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify(metadata())},payload:Buffer.from('bad')});expect(corrupt.statusCode).toBe(422);
    expect((await app.inject({method:'GET',url:'/api/assets',headers})).json()).toEqual([]);
    expect((await app.inject({method:'GET',url:'/api/scenes/missing',headers})).statusCode).toBe(404);
  });
});
