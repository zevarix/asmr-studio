import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyScene } from '@asmr-studio/contracts';
import { AssetStore } from './assets.js';
import { buildApp } from './app.js';
import { openStore } from './store.js';
import { loadBuiltWeb, registerBuiltWeb } from './static-web.js';

const origin='http://127.0.0.1:4318';
const headers={host:'127.0.0.1:4318'};
const entry='<!doctype html><script type="module" src="/assets/index-build123.js"></script>'
  +'<link rel="stylesheet" href="/assets/index-build123.css"><div id="root">Studio</div>';
let root:string;
let web:string;
let store:ReturnType<typeof openStore>;
let app:ReturnType<typeof buildApp>;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'asmr-static-'));
  web=join(root,'web');
  mkdirSync(join(web,'assets'),{recursive:true});
  writeFileSync(join(web,'index.html'),entry);
  writeFileSync(join(web,'assets','index-build123.js'),'console.log("built studio");');
  writeFileSync(join(web,'assets','index-build123.css'),'body { color: green; }');
  writeFileSync(join(root,'private.txt'),'private library bytes');
  store=openStore(join(root,'data','studio.sqlite'));
  const assets=new AssetStore({root:join(root,'data','media'),repository:store.assets,
    maxUploadBytes:1024*1024,decodedBudgetBytes:1024*1024,acceptedFormats:['wav']});
  app=buildApp({scenes:store.scenes,assets,allowedOrigin:origin});
});
afterEach(async()=>{
  await app.close();
  store.close();
  rmSync(root,{recursive:true,force:true});
});
function mount():void {registerBuiltWeb(app,loadBuiltWeb(web));}

describe('built local studio',()=>{
  it('serves the same-origin entry point, query-linked sessions, scripts and styles',async()=>{
    mount();
    for (const url of ['/','/index.html','/?scene=saved-session']) {
      const response=await app.inject({method:'GET',url,headers});
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.body).toContain('id="root"');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
    const script=await app.inject({method:'GET',url:'/assets/index-build123.js',headers});
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).toBe('console.log("built studio");');
    const style=await app.inject({method:'GET',url:'/assets/index-build123.css',headers});
    expect(style.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(style.body).toBe('body { color: green; }');
    const head=await app.inject({method:'HEAD',url:'/assets/index-build123.js',headers});
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(script.body));
  });
  it('keeps API routes, exact Host/Origin checks, and mutation protection',async()=>{
    mount();
    const health=await app.inject({method:'GET',url:'/api/health',headers});
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({status:'ok'});
    for (const url of ['/','/assets/index-build123.js','/api/health']) {
      expect((await app.inject({method:'GET',url,headers:{host:'attacker.example'}})).statusCode).toBe(403);
      expect((await app.inject({method:'GET',url,headers:{...headers,origin:'https://attacker.example'}})).statusCode).toBe(403);
    }
    const scene=createEmptyScene('saved','Saved in the built studio');
    expect((await app.inject({method:'POST',url:'/api/scenes',headers,payload:scene})).statusCode).toBe(403);
    expect(store.scenes.get(scene.id)).toBeNull();
    const saved=await app.inject({method:'POST',url:'/api/scenes',headers:{...headers,origin},payload:scene});
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({id:scene.id,revision:1});
    expect((await app.inject({method:'POST',url:'/',headers:{...headers,origin}})).statusCode).toBe(404);
  });
  it('serves an audio worklet that is loaded by the entry script rather than the HTML',async()=>{
    const worklet='registerProcessor("studio-output", class extends AudioWorkletProcessor {});';
    writeFileSync(join(web,'assets','output-worklet-audio123.js'),worklet);
    mount();
    const response=await app.inject({method:'GET',url:'/assets/output-worklet-audio123.js',headers:{...headers,origin}});
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.body).toBe(worklet);
    expect((await app.inject({method:'GET',url:'/assets/output-worklet-audio123.js',
      headers:{...headers,origin:'https://attacker.example'}})).statusCode).toBe(403);
  });
  it('does not serve private files, source maps, source code or unknown API routes as HTML',async()=>{
    writeFileSync(join(web,'assets','index-build123.js.map'),'private source map');
    writeFileSync(join(web,'assets','settings.json'),'private settings');
    writeFileSync(join(web,'private.txt'),'private build file');
    mount();
    for (const url of ['/private.txt','/assets/index-build123.js.map','/assets/settings.json',
      '/apps/web/src/main.tsx','/assets/%2e%2e/%2e%2e/private.txt','/%2e%2e/private.txt',
      '/assets/..%2f..%2fprivate.txt','/assets/..%5c..%5cprivate.txt','/assets/missing.js',
      '/api/unknown','/unrecognized/session']) {
      const response=await app.inject({method:'GET',url,headers});
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('private library bytes');
      expect(response.body).not.toContain('id="root"');
    }
  });
  it('keeps a coherent in-memory build when files are changed after startup',async()=>{
    mount();
    writeFileSync(join(web,'assets','index-build123.js'),'changed on disk');
    rmSync(join(web,'index.html'));
    const response=await app.inject({method:'GET',url:'/assets/index-build123.js',headers});
    expect(response.body).toBe('console.log("built studio");');
    expect((await app.inject({method:'GET',url:'/',headers})).body).toContain('id="root"');
  });
  it('rejects missing or incomplete builds with an actionable error',()=>{
    expect(()=>loadBuiltWeb(join(root,'missing'))).toThrow('Run npm run build');
    rmSync(join(web,'index.html'));
    expect(()=>loadBuiltWeb(web)).toThrow('Run npm run build');
    writeFileSync(join(web,'index.html'),entry);
    rmSync(join(web,'assets'),{recursive:true});
    expect(()=>loadBuiltWeb(web)).toThrow('Run npm run build');
    mkdirSync(join(web,'assets'));
    expect(()=>loadBuiltWeb(web)).toThrow('Run npm run build');
  });
  it('rejects an incomplete entry page even when other build assets remain',()=>{
    rmSync(join(web,'assets','index-build123.js'));
    expect(()=>loadBuiltWeb(web)).toThrow('Run npm run build');
    writeFileSync(join(web,'assets','index-build123.js'),'restored script');
    rmSync(join(web,'assets','index-build123.css'));
    expect(()=>loadBuiltWeb(web)).toThrow('Run npm run build');
    writeFileSync(join(web,'assets','index-build123.css'),'restored stylesheet');
    writeFileSync(join(web,'index.html'),'<!doctype html><div id="root"></div>');
    expect(()=>loadBuiltWeb(web)).toThrow('Run npm run build');
  });
  it('rejects symlinked files, asset directories and build roots',()=>{
    symlinkSync(join(root,'private.txt'),join(web,'assets','private.js'));
    expect(()=>loadBuiltWeb(web)).toThrow('missing or invalid');
    rmSync(join(web,'assets','private.js'));
    rmSync(join(web,'index.html'));
    symlinkSync(join(root,'private.txt'),join(web,'index.html'));
    expect(()=>loadBuiltWeb(web)).toThrow('missing or invalid');
    rmSync(join(web,'index.html'));
    writeFileSync(join(web,'index.html'),entry);
    symlinkSync(web,join(web,'assets','recursive'));
    expect(()=>loadBuiltWeb(web)).toThrow('missing or invalid');
    symlinkSync(web,join(root,'alias'));
    expect(()=>loadBuiltWeb(join(root,'alias'))).toThrow('missing or invalid');
  });
  it('leaves the existing API-only app unchanged without registration',async()=>{
    expect((await app.inject({method:'GET',url:'/',headers})).statusCode).toBe(404);
    expect((await app.inject({method:'GET',url:'/api/health',headers})).statusCode).toBe(200);
  });
});
