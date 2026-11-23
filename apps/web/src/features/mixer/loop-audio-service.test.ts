import {describe,expect,it,vi} from 'vitest';
import type {AssetRecord} from '@asmr-studio/contracts';
import {buildWaveform,createLoopAudioService} from './loop-audio-service.js';

const signal = new AbortController().signal;
const asset = (id:string):AssetRecord => ({id,sha256:id,sampleRate:48000,durationSeconds:1,channels:2,
  format:'wav',displayName:id,roles:['ambience'],provenance:{kind:'original',source:null},rights:{privateUse:'permitted',redistribution:'unknown'}});
function buffer(...samples:Float32Array[]) {
  return {length:samples[0]!.length,sampleRate:48000,numberOfChannels:samples.length,
    getChannelData:(index:number)=>samples[index]} as AudioBuffer;
}
const short = buffer(Float32Array.of(0.5,-0.25));
function context(decode = vi.fn(async (_:ArrayBuffer)=>short)) {
  return {sampleRate:48000,decodeAudioData:decode,close:vi.fn(async()=>{})} as unknown as AudioContext;
}
const response = () => new Response(Uint8Array.of(1));
describe('waveform',()=>{
  it('retains both stereo extrema and the last frame across uneven bounded bins',async()=>{
    const left = new Float32Array(2049).fill(0.25);
    const right = new Float32Array(2049).fill(-0.25);
    left[2048] = 0.875;
    const peaks = await buildWaveform(buffer(left,right),signal);
    expect(peaks.min.length).toBe(1024);
    expect(peaks.min.every(n=>n===-0.25)).toBe(true);
    expect(peaks.max[0]).toBe(0.25);
    expect(peaks.max.at(-1)).toBe(0.875);
    expect(peaks.durationSeconds).toBe(2049/48000);
    expect(Array.from((await buildWaveform(short,signal)).min)).toEqual([0.5,-0.25]);
  });
  it('stops a scan on release before caching and evicts least recently used waveforms',async()=>{
    const service = createLoopAudioService();
    const reading = service.waveform(asset('long'),buffer(new Float32Array(300000)),signal);
    service.release();
    await expect(reading).rejects.toMatchObject({name:'AbortError'});
    const saved = await service.waveform(asset('old'),short,signal);
    expect(await service.waveform(asset('old'),short,signal)).toBe(saved);
    for (let i=0;i<16;i++) await service.waveform(asset(String(i)),short,signal);
    expect(await service.waveform(asset('old'),short,signal)).not.toBe(saved);
  });
});
describe('loop audio service',()=>{
  it('borrows decoded and in-flight recordings, releases references, and ignores stale borrows',async()=>{
    let resolve!:(value:AudioBuffer)=>void;
    const pending = new Promise<AudioBuffer>(r=>{resolve=r;});
    const createContext = vi.fn(()=>context());
    const service = createLoopAudioService({getDecodedAsset:id=>id==='old'?pending:short,createContext});
    const old = service.acquire(asset('old'),signal);
    expect(await service.acquire(asset('now'),signal)).toBe(short);
    resolve(short);
    await expect(old).rejects.toMatchObject({name:'AbortError'});
    expect(service.peek('now')).toBe(short);
    expect(service.peek('old')).toBeUndefined();
    service.release();
    expect(service.peek('now')).toBeUndefined();
    await expect(service.acquire(asset('old'),signal)).resolves.toBe(short);
    expect(createContext).not.toHaveBeenCalled();
  });
  it('serializes unabortable decodes and drops the superseded result',async()=>{
    let done!:(value:AudioBuffer)=>void;
    const decode = vi.fn(async (_:ArrayBuffer)=>short).mockImplementationOnce(()=>new Promise(r=>{done=r;}));
    const audio = context(decode);
    const fetcher = vi.fn(async()=>response());
    const service = createLoopAudioService({createContext:()=>audio,fetch:fetcher});
    const old = service.acquire(asset('old'),signal);
    await vi.waitFor(()=>expect(decode).toHaveBeenCalledTimes(1));
    const latest = service.acquire(asset('new'),signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    done(short);
    await expect(old).rejects.toMatchObject({name:'AbortError'});
    expect(await latest).toBe(short);
    expect(service.peek('old')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(service.context()).toBe(audio);
    service.dispose();service.dispose();
    expect(audio.close).toHaveBeenCalledTimes(1);
  });
  it('aborts an active fetch on release',async()=>{
    let fetchSignal:AbortSignal|undefined;
    const service = createLoopAudioService({createContext:()=>context(),fetch:async(_,init)=>{
      fetchSignal=init!.signal!;
      return new Promise<Response>((_,reject)=>fetchSignal!.addEventListener('abort',()=>reject(fetchSignal!.reason)));
    }});
    const pending=service.acquire(asset('old'),signal);
    await vi.waitFor(()=>expect(fetchSignal).toBeDefined());
    service.release();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    expect(fetchSignal!.aborted).toBe(true);
  });
  it('stops a chunked response at the byte limit even without a length header',async()=>{
    const chunk = new Uint8Array(1024*1024);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(chunk);},cancel});
    const audio = context();
    const service = createLoopAudioService({createContext:()=>audio,fetch:async()=>new Response(stream)});
    await expect(service.acquire(asset('chunked'),signal)).rejects.toThrow('memory limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(audio.decodeAudioData).not.toHaveBeenCalled();
  });
  it('limits preflight size, encoded length and actual decoded size, then permits retry',async()=>{
    const oversized={...short,length:17_000_000} as AudioBuffer;
    const decode=vi.fn(async (_:ArrayBuffer)=>short).mockResolvedValueOnce(oversized);
    const fetcher=vi.fn(async()=>response()).mockResolvedValueOnce(new Response('x',{headers:{'content-length':String(64*1024*1024+1)}}));
    const service=createLoopAudioService({createContext:()=>context(decode),fetch:fetcher});
    await expect(service.acquire({...asset('x'),durationSeconds:3600},signal)).rejects.toThrow('memory limit');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(service.acquire(asset('x'),signal)).rejects.toThrow('memory limit');
    expect(decode).not.toHaveBeenCalled();
    await expect(service.acquire(asset('x'),signal)).rejects.toThrow('memory limit');
    expect(service.peek('x')).toBeUndefined();
    expect(await service.acquire(asset('x'),signal)).toBe(short);
  });
});
