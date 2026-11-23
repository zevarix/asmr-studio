import {describe,expect,it} from 'vitest';
import {createLoopJoinPreview,getLoopFrames,prepareLoop} from './loops.js';
import {fakeBuffer} from './test-utils/fake-context.js';
describe('linear loop preparation',()=>{
  it('preserves constant stereo amplitude across an overlap and wrap',()=>{
    const input=fakeBuffer(2,1000,1000);input.getChannelData(1).fill(-0.125);
    const loop=prepareLoop(input,{startSeconds:0,endSeconds:1,crossfadeSeconds:0.2},fakeBuffer);
    expect(loop.periodSeconds).toBe(0.8);expect(loop.introSeconds).toBe(0.2);expect(loop.buffer.length).toBe(800);
    expect([...loop.buffer.getChannelData(0)].every(x=>Math.abs(x-0.25)<1e-7)).toBe(true);
    expect([...loop.buffer.getChannelData(1)].every(x=>Math.abs(x+0.125)<1e-7)).toBe(true);
  });
  it('rejects a zero-frame loop and preserves the original buffer for no crossfade',()=>{
    const input=fakeBuffer();expect(()=>prepareLoop(input,{startSeconds:0,endSeconds:0.00000001,crossfadeSeconds:0},fakeBuffer)).toThrow();
    const loop=prepareLoop(input,{startSeconds:0.1,endSeconds:0.8,crossfadeSeconds:0},fakeBuffer);expect(loop.buffer).toBe(input);expect(loop.extraBytes).toBe(0);
  });
});

describe('join preview',()=>{
  it.each([
    {channels:1,start:2,end:3,fade:0},
    {channels:2,start:2,end:12,fade:0},
    {channels:2,start:2,end:18,fade:3},
    {channels:1,start:2,end:18,fade:8},
    {channels:2,start:2,end:202,fade:50},
  ])('matches repeated playback for $channels channels, frames $start–$end, fade $fade',({channels,start,end,fade})=>{
    const rate=16;
    const input=fakeBuffer(channels,256,rate);
    const original=Array.from({length:channels},(_,channel)=>{
      const samples=input.getChannelData(channel);
      for(let i=0;i<samples.length;i++) samples[i]=Math.sin(i+2*channel);
      return samples.slice();
    });
    const loop={startSeconds:start/rate,endSeconds:end/rate,crossfadeSeconds:fade/rate};
    const allocations:number[]=[];
    const preview=createLoopJoinPreview(input,loop,(count,length,sampleRate)=>{
      allocations.push(length);
      return fakeBuffer(count,length,sampleRate);
    });
    const prepared=prepareLoop(input,loop,fakeBuffer);
    expect(allocations).toEqual([2*rate]);
    expect(preview.sampleRate).toBe(rate);
    expect(preview.numberOfChannels).toBe(channels);
    const period=end-start-fade;
    for(let c=0;c<channels;c++){
      const repeated=prepared.buffer.getChannelData(c);
      const expected=Array.from({length:2*rate},(_,i)=>{
        const phase=((i-rate)%period+period)%period;
        return repeated[prepared.offsetBaseSeconds*rate+phase];
      });
      expect(Array.from(preview.getChannelData(c))).toEqual(expected);
      expect(input.getChannelData(c)).toEqual(original[c]);
    }
  });

  it('uses the playback linear weights in the final overlap frames',()=>{
    const input=fakeBuffer(1,8,8);
    input.getChannelData(0).set([0,1,2,3,4,5,6,7]);
    const preview=createLoopJoinPreview(input,{startSeconds:0,endSeconds:1,crossfadeSeconds:.25},fakeBuffer);
    expect([...preview.getChannelData(0).slice(5,11)]).toEqual([5,3,1,2,3,4]);
  });

  it('validates rounded frames using just decoded length and rate',()=>{
    const meta={sampleRate:10,length:10};
    expect(getLoopFrames(meta,{startSeconds:.06,endSeconds:.99,crossfadeSeconds:.24}))
      .toEqual({rate:10,start:1,end:10,crossfade:2,length:9,period:7});
    for(const loop of [
      {startSeconds:.105,endSeconds:.11,crossfadeSeconds:0},
      {startSeconds:0,endSeconds:1.06,crossfadeSeconds:0},
    ]){
      expect(()=>getLoopFrames(meta,loop)).toThrow();
    }
    expect(()=>getLoopFrames({...meta,sampleRate:NaN},{startSeconds:0,endSeconds:1,crossfadeSeconds:0})).toThrow();
    const roundedInvalid={startSeconds:.051,endSeconds:.249,crossfadeSeconds:.09};
    expect(()=>getLoopFrames(meta,roundedInvalid)).toThrow();
    expect(()=>createLoopJoinPreview(fakeBuffer(1,10,10),roundedInvalid,fakeBuffer)).toThrow();
  });
});
