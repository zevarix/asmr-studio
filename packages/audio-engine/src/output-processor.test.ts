import {describe,expect,it} from 'vitest';
import {StereoOutputProcessor} from './output-processor.js';

function run(processor:StereoOutputProcessor,left:number[]|Float32Array,right:number[]|Float32Array){
  const l=Float32Array.from(left),r=Float32Array.from(right);
  const outL=new Float32Array(l.length),outR=new Float32Array(r.length);
  processor.process(l,r,outL,outR);
  return [outL,outR] as const;
}

describe('stereo output processing',()=>{
  it('applies listening gain after limiting and measures the final faded samples',()=>{
    const processor=new StereoOutputProcessor(48000);processor.setLimiter({enabled:true,ceilingDb:-6.020599913279624});
    const left=new Float32Array([2,2,2]),right=new Float32Array([1,1,1]);
    processor.process(left,right,left,right,new Float32Array([.5,.25,0]));
    expect(left).toEqual(new Float32Array([.25,.125,0]));expect(right).toEqual(new Float32Array([.125,.0625,0]));
    const meter=processor.takeMeterSnapshot();
    expect(meter.peak).toEqual([.25,.125]);expect(meter.heldPeak).toEqual([.25,.125]);
    expect(meter.rms[0]).toBeCloseTo(Math.sqrt((.25**2+.125**2)/3),9);
    expect(meter.gainReductionDb).toBeCloseTo(-20*Math.log10(.25),9);
  });
  it('preserves unity exactly and accepts constant or per-frame listening gain across blocks',()=>{
    const signal=new Float32Array([0,-0,.2,-.7,1.3]),other=new Float32Array([0,0,-.4,.3,-.2]);
    const neutral=new StereoOutputProcessor(48000),one=new StereoOutputProcessor(48000),whole=new StereoOutputProcessor(48000),chunks=new StereoOutputProcessor(48000);
    const unityL=signal.slice(),unityR=other.slice();one.process(unityL,unityR,unityL,unityR,new Float32Array([1]));
    expect([unityL,unityR]).toEqual(run(neutral,signal,other));
    const gains=new Float32Array([0,.1,.2,.3,.4]),l=signal.slice(),r=other.slice(),expectedL=signal.slice(),expectedR=other.slice();
    whole.process(expectedL,expectedR,expectedL,expectedR,gains);
    chunks.process(l.subarray(0,2),r.subarray(0,2),l.subarray(0,2),r.subarray(0,2),gains.subarray(0,2));
    chunks.process(l.subarray(2),r.subarray(2),l.subarray(2),r.subarray(2),gains.subarray(2));
    expect([l,r]).toEqual([expectedL,expectedR]);expect(l[4]).toBe(Math.fround(signal[4]!*gains[4]!));
  });
  it('silences invalid envelope values and still detects invalid audio behind a zero gain',()=>{
    const processor=new StereoOutputProcessor(48000),l=new Float32Array([.5,.5,.5]),r=l.slice();
    processor.process(l,r,l,r,new Float32Array([1,NaN,1]));expect(l[1]).toBe(0);expect(l[2]).toBe(0);
    expect(processor.takeMeterSnapshot().error).toMatch(/invalid/i);processor.reset();
    processor.process(new Float32Array([NaN]),new Float32Array([0]),l.subarray(0,1),r.subarray(0,1),new Float32Array([0]));
    expect(processor.takeMeterSnapshot().error).toMatch(/invalid/i);
    expect(()=>new StereoOutputProcessor(48000).process(l,r,l,r,new Float32Array(2))).toThrow(/gain/i);
  });
  it('copies disabled and quiet enabled samples exactly, including silence and independent channel polarity',()=>{
    const source=[0,-0,.125,-.25,.5];const right=[0,0,-.5,.125,-.25];
    const processor=new StereoOutputProcessor(48000);
    expect(run(processor,source,right)).toEqual([Float32Array.from(source),Float32Array.from(right)]);
    processor.setLimiter({enabled:true,ceilingDb:-1},false);
    expect(run(processor,source,right)).toEqual([Float32Array.from(source),Float32Array.from(right)]);
  });

  it('limits the first over-ceiling sample and applies the same gain to both channels without adding delay',()=>{
    const processor=new StereoOutputProcessor(48000);
    processor.setLimiter({enabled:true,ceilingDb:-6.020599913279624},false);
    const [left,right]=run(processor,[2,.1,0],[.5,-.2,0]);
    expect(left[0]).toBe(.5);expect(right[0]).toBe(.125);
    expect(left[1]).toBeGreaterThan(.025);expect(left[1]).toBeLessThan(.026);
    expect(right[1]).toBeCloseTo(-2*left[1]!,7);
    expect(left[2]).toBe(0);expect(right[2]).toBe(0);
    expect(processor.takeMeterSnapshot()).toMatchObject({available:true,heldPeak:[.5,.125],clipped:[false,false]});
  });

  it('holds a sample ceiling across asymmetric peaks and recovers gently without makeup gain',()=>{
    const processor=new StereoOutputProcessor(48000);
    processor.setLimiter({enabled:true,ceilingDb:-1},false);
    const frames=48000;const left=new Float32Array(frames).fill(.1);const right=new Float32Array(frames).fill(-.2);
    left[0]=4;right[124]=8;left[711]=-3;
    const [l,r]=run(processor,left,right);const ceiling=Math.fround(10**(-1/20));
    expect(Math.max(...l.map(Math.abs),...r.map(Math.abs))).toBeLessThanOrEqual(ceiling);
    expect(l[2]).toBeLessThan(.03);expect(l[4800]).toBeGreaterThan(l[2400]!);
    expect(l.at(-1)).toBeCloseTo(.1,4);expect(l.at(-1)).toBeLessThanOrEqual(.1);
    for(let index=1000;index<frames;index++)expect(r[index]).toBeCloseTo(-2*l[index]!,7);
    expect(processor.takeMeterSnapshot().gainReductionDb).toBeGreaterThan(18);
  });

  it('produces identical samples regardless of block sizes or in-place operation',()=>{
    const frames=4351;const left=Float32Array.from({length:frames},(_,i)=>Math.sin(i*.17)*1.3);
    const right=Float32Array.from({length:frames},(_,i)=>Math.cos(i*.11)*1.1);
    const whole=new StereoOutputProcessor(44100),chunked=new StereoOutputProcessor(44100);
    for(const value of [whole,chunked])value.setLimiter({enabled:true,ceilingDb:-3},false);
    const expected=run(whole,left,right);const l=left.slice(),r=right.slice();
    for(let index=0;index<frames;index+=137)chunked.process(l.subarray(index,index+137),r.subarray(index,index+137),l.subarray(index,index+137),r.subarray(index,index+137));
    expect([l,r]).toEqual(expected);
  });

  it('captures brief peaks and independent clipping between meter reads, then resets only requested holds',()=>{
    const processor=new StereoOutputProcessor(48000);
    run(processor,[.25,1.2,0],[.5,0,-1]);
    run(processor,[0,0],[0,0]);
    const first=processor.takeMeterSnapshot();
    expect(first.peak[0]).toBeCloseTo(1.2,6);expect(first.peak[1]).toBe(1);
    expect(first.clipped).toEqual([true,true]);expect(first.rms[0]).toBeCloseTo(Math.sqrt((.25**2+1.2**2)/5),6);
    expect(processor.takeMeterSnapshot()).toMatchObject({peak:[0,0],rms:[0,0],heldPeak:first.heldPeak,clipped:[true,true],gainReductionDb:0});
    processor.resetPeaks();
    expect(processor.takeMeterSnapshot()).toMatchObject({heldPeak:[0,0],clipped:[false,false]});
  });

  it('smoothly disengages active attenuation and reaches an exact neutral endpoint',()=>{
    const processor=new StereoOutputProcessor(48000);
    processor.setLimiter({enabled:true,ceilingDb:-6.020599913279624},false);
    run(processor,[2],[1]);processor.setLimiter({enabled:false,ceilingDb:-6.020599913279624},true);
    const [left]=run(processor,new Float32Array(1000).fill(.5),new Float32Array(1000).fill(.25));
    expect(left[0]).toBeGreaterThan(.125);expect(left[0]).toBeLessThan(.126);
    expect(left[479]).toBeCloseTo(.3125,6);expect(left[959]).toBe(.5);expect(left[999]).toBe(.5);
    expect(run(processor,[.125,-.25,0],[.5,0,-.5])).toEqual([Float32Array.from([.125,-.25,0]),Float32Array.from([.5,0,-.5])]);
  });

  it('resets scene history and rejects invalid settings without changing the active limiter',()=>{
    const processor=new StereoOutputProcessor(48000);
    processor.setLimiter({enabled:true,ceilingDb:-6.020599913279624},false);run(processor,[4],[2]);
    expect(()=>processor.setLimiter({enabled:true,ceilingDb:NaN},true)).toThrow();
    expect(()=>processor.setLimiter({enabled:true,ceilingDb:0},true)).toThrow();
    expect(run(processor,[4],[2])[0][0]).toBe(.5);
    processor.reset();expect(processor.takeMeterSnapshot()).toMatchObject({heldPeak:[0,0],clipped:[false,false],gainReductionDb:0});
    expect(run(processor,[.25],[.125])[0][0]).toBe(.25);
  });

  it('silences invalid sample data and exposes a persistent fault until reset',()=>{
    const processor=new StereoOutputProcessor(48000);
    const [left,right]=run(processor,[.25,NaN,.5],[.125,.1,.25]);
    expect(left[1]).toBe(0);expect(right[1]).toBe(0);expect(left[2]).toBe(0);
    expect(processor.takeMeterSnapshot().error).not.toBeNull();
    expect(run(processor,[.25],[.125])[0][0]).toBe(0);
    processor.reset();expect(run(processor,[.25],[.125])[0][0]).toBe(.25);
  });
});
