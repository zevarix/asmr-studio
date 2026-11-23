import {act,renderHook,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {fixtureAsset} from '../../../../../tests/fixtures/scene.js';
import type {LoopAudioService} from './loop-audio-service.js';
import {useLoopEditorAudio} from './useLoopEditorAudio.js';

const asset = fixtureAsset();
const loop = {startSeconds:0,endSeconds:1,crossfadeSeconds:0};
function makeBuffer(channels:number,frames:number,rate:number) {
  const data = Array.from({length:channels},()=>new Float32Array(frames));
  return {numberOfChannels:channels,length:frames,sampleRate:rate,getChannelData:(channel:number)=>data[channel]} as AudioBuffer;
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise = new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}
function setup() {
  const buffer = makeBuffer(1,48,48);
  const source = {onended:null as (()=>void)|null,buffer:null as AudioBuffer|null,
    start:vi.fn(),stop:vi.fn(),connect:vi.fn(),disconnect:vi.fn()};
  const gain = {gain:{cancelScheduledValues:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn()};
  const audio = {currentTime:4,state:'running',resume:vi.fn(async()=>{}),createBuffer:vi.fn(makeBuffer),destination:{},
    createGain:()=>gain,createBufferSource:vi.fn(()=>source)};
  const service = {context:()=>audio as unknown as AudioContext,
    acquire:vi.fn<LoopAudioService['acquire']>(async()=>buffer),
    waveform:vi.fn<LoopAudioService['waveform']>(async()=>({durationSeconds:1,frameCount:48,sampleRate:48,
      min:new Float32Array(48),max:new Float32Array(48)})),peek:vi.fn(),release:vi.fn(),dispose:vi.fn()} satisfies LoopAudioService;
  const onPreviewStart = vi.fn();
  const render = () => renderHook(({key,mixActive,stopToken}:{key:string|null;mixActive:boolean;stopToken:number})=>
    useLoopEditorAudio(service,asset,key,{mixActive,stopToken,onPreviewStart}),{initialProps:{key:'layer' as string|null,mixActive:false,stopToken:0}});
  return {buffer,audio,source,gain,service,render,onPreviewStart};
}
describe('loop editor audio',()=>{
  it('drops a pending acquisition on close and a stale result cannot enable playback',async()=>{
    const f = setup();
    const pending = deferred<AudioBuffer>();
    f.service.acquire.mockReturnValueOnce(pending.promise);
    const {result,rerender} = f.render();
    const acquisition = f.service.acquire.mock.calls[0]![1];
    rerender({key:null,mixActive:false,stopToken:0});
    expect(acquisition.aborted).toBe(true);
    expect(f.service.release).toHaveBeenCalledOnce();
    await act(async()=>pending.resolve(f.buffer));
    expect(result.current.waveform.status).toBe('idle');
    expect(result.current.preview.disabled).toBe(true);
    expect(f.service.waveform).not.toHaveBeenCalled();
  });
  it('keeps the actual decoded bounds and enables audition after waveform failure',async()=>{
    const f = setup();
    f.service.waveform.mockRejectedValueOnce(new Error('peaks failed'));
    const {result} = f.render();
    await waitFor(()=>expect(result.current.waveform).toMatchObject({status:'error',sampleRate:48,frameCount:48}));
    expect(result.current.preview.disabled).toBe(false);
  });
  it('resumes during the gesture and disconnects a finite gain-shaped excerpt on end',async()=>{
    const f = setup();
    const {result} = f.render();
    await waitFor(()=>expect(result.current.waveform.status).toBe('ready'));
    act(()=>result.current.preview.onPlay(loop));
    expect(f.audio.resume).toHaveBeenCalledOnce();
    expect(f.onPreviewStart).toHaveBeenCalledOnce();
    await waitFor(()=>expect(result.current.preview.state.status).toBe('playing'));
    expect(f.source.buffer).not.toBe(f.buffer);
    expect(f.source.buffer!.length).toBe(96);
    expect(f.source.start).toHaveBeenCalledWith(4);
    expect(f.gain.gain.linearRampToValueAtTime.mock.calls).toEqual([[.25,4.02],[0,6]]);
    act(()=>f.source.onended!());
    expect(result.current.preview.state.status).toBe('idle');
    expect(f.source.buffer).toBeNull();
    expect(f.gain.disconnect).toHaveBeenCalledOnce();
    expect(f.source.disconnect).toHaveBeenCalledOnce();
    expect(f.service.release).not.toHaveBeenCalled();
  });
  it('fades from the current attack gain on manual stop and releases the buffer when the fade ends',async()=>{
    const f = setup();
    const {result} = f.render();
    await waitFor(()=>expect(result.current.waveform.status).toBe('ready'));
    await act(async()=>result.current.preview.onPlay(loop));
    f.audio.currentTime = 4.01;
    act(()=>result.current.preview.onStop());
    expect(result.current.preview.state.status).toBe('idle');
    expect(f.gain.gain.cancelScheduledValues).toHaveBeenCalledWith(4.01);
    expect(f.gain.gain.setValueAtTime.mock.lastCall![0]).toBeCloseTo(.125);
    expect(f.gain.gain.linearRampToValueAtTime.mock.lastCall![1]).toBeCloseTo(4.03);
    expect(f.source.stop.mock.lastCall![0]).toBeCloseTo(4.03);
    expect(f.source.disconnect).not.toHaveBeenCalled();
    act(()=>f.source.onended!());
    expect(f.source.buffer).toBeNull();
    expect(f.source.disconnect).toHaveBeenCalledOnce();
  });
  it('guards a delayed resume after a new stop token and ignores old callbacks during playback',async()=>{
    const f = setup();
    const resumed = deferred<void>();
    f.audio.resume.mockReturnValueOnce(resumed.promise);
    const {result,rerender} = f.render();
    await waitFor(()=>expect(result.current.waveform.status).toBe('ready'));
    const play = result.current.preview.onPlay;
    act(()=>play(loop));
    rerender({key:'layer',mixActive:false,stopToken:1});
    await act(async()=>resumed.resolve());
    expect(f.audio.createBufferSource).not.toHaveBeenCalled();
    expect(f.service.release).not.toHaveBeenCalled();
    rerender({key:'layer',mixActive:true,stopToken:1});
    act(()=>play(loop));
    expect(f.audio.resume).toHaveBeenCalledOnce();
    expect(result.current.preview.disabled).toBe(true);
    expect(result.current.preview.requiresPause).toBe(true);
  });
  it('invalidates a delayed resume on editor switch and cleans an active source on unmount',async()=>{
    const f = setup();
    const resumed = deferred<void>();
    f.audio.resume.mockReturnValueOnce(resumed.promise);
    const {result,rerender,unmount} = f.render();
    await waitFor(()=>expect(result.current.waveform.status).toBe('ready'));
    act(()=>result.current.preview.onPlay(loop));
    rerender({key:'next',mixActive:false,stopToken:0});
    await act(async()=>resumed.resolve());
    expect(f.audio.createBufferSource).not.toHaveBeenCalled();
    await act(async()=>result.current.preview.onPlay(loop));
    expect(f.source.start).toHaveBeenCalledOnce();
    unmount();
    expect(f.source.disconnect).toHaveBeenCalledOnce();
    expect(f.source.stop).toHaveBeenCalledOnce();
  });
});
