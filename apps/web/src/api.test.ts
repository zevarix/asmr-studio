import {afterEach,describe,expect,it,vi} from 'vitest';
import {StudioApi} from './api.js';

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const api=new StudioApi();
function response(value:unknown){
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(value),{status:200})));
}

describe('starter catalog loop defaults',()=>{
  it('reads optional prepared loops without coupling the browser to attribution or downloader fields',async()=>{
    const preferredLoop={startSeconds:0,endSeconds:20,crossfadeSeconds:0};
    response([
      {id:'prepared',assetId:'asset-prepared',preferredLoop,title:'Prepared sound',downloadUrl:'https://example.test/sound.wav'},
      {id:'recording',assetId:'asset-recording'},
      {id:'not-installed',assetId:null,preferredLoop},
    ]);
    await expect(api.listStarterSounds()).resolves.toEqual([
      {id:'prepared',assetId:'asset-prepared',preferredLoop},
      {id:'recording',assetId:'asset-recording'},
      {id:'not-installed',assetId:null,preferredLoop},
    ]);
    expect(fetch).toHaveBeenCalledWith('/api/library',expect.objectContaining({credentials:'same-origin',signal:expect.any(AbortSignal)}));
  });

  it.each([
    {id:'sound',assetId:42},
    {id:'sound',assetId:' '},
    {id:'sound',assetId:null,preferredLoop:{startSeconds:5,endSeconds:3,crossfadeSeconds:0}},
    {id:'sound',assetId:null,preferredLoop:{startSeconds:0,endSeconds:20,crossfadeSeconds:11}},
    {id:'sound',assetId:null,preferredLoop:{startSeconds:0,endSeconds:20,crossfadeSeconds:null}},
  ])('rejects invalid catalog identity or loop data: %j',async entry=>{
    response([entry]);
    await expect(api.listStarterSounds()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });

  it('rejects a non-catalog response',async()=>{
    response({sounds:[]});
    await expect(api.listStarterSounds()).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });

  it('bounds a lost optional catalog request and clears its timeout',async()=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    vi.stubGlobal('fetch',vi.fn((_url:string,options:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      signal=options.signal!;
      signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    })));
    const request=api.listStarterSounds().catch(error=>error as unknown);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await request).toMatchObject({code:'NETWORK_ERROR'});
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
