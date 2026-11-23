import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodePcm16Wav} from '../../../tests/fixtures/export.js';
import {writeProcessedWav} from './output-wav.js';

const roots:string[]=[];
async function destination(){const root=await mkdtemp(join(tmpdir(),'asmr-output-wav-'));roots.push(root);return {root,outputPath:join(root,'limited.wav')};}
function stereo(values:Array<[number,number]>):Buffer{const result=Buffer.alloc(values.length*8);values.forEach(([left,right],frame)=>{result.writeFloatLE(left,frame*8);result.writeFloatLE(right,frame*8+4);});return result;}
const settings={enabled:true,ceilingDb:-6};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('bounded processed PCM WAV stream',()=>{
  it('applies session fades on the complete output timeline across split chunks and processing blocks',async()=>{
    const frames=4097,rate=48000;
    const input=stereo(Array.from({length:frames},()=>[.5,-.25] as [number,number]));
    const listeningTimer={enabled:true,durationSeconds:10,fadeInSeconds:513/rate,fadeOutSeconds:1000/rate};
    const whole=await destination(),split=await destination();
    for(const [target,step] of [[whole,input.length],[split,4091]] as const){
      await writeProcessedWav({...target,frames,sampleRate:rate,settings:{enabled:false,ceilingDb:-6},listeningTimer,
        signal:new AbortController().signal},async write=>{
        for(let at=0;at<input.length;at+=step)await write(input.subarray(at,at+step));
      });
    }
    expect(await readFile(split.outputPath)).toEqual(await readFile(whole.outputPath));
    const output=decodePcm16Wav(await readFile(split.outputPath));
    expect(output.frames).toBe(frames);
    for(const [frame,gain] of [[0,0],[256,256/513],[513,1],[1024,1],[2048,1],[3097,1],[3347,.75],[3597,.5],[3847,.25],[4096,.001]] as const){
      expect(Math.abs(output.channelData[0]![frame]!-gain*.5)).toBeLessThanOrEqual(1/32768);
      expect(Math.abs(output.channelData[1]![frame]!+gain*.25)).toBeLessThanOrEqual(1/32768);
    }
  });

  it('fades the already limited output instead of keeping a hot mix at its ceiling',async()=>{
    const target=await destination(),frames=4800,rate=48000;
    const input=stereo(Array.from({length:frames},()=>[2,-1] as [number,number]));
    await writeProcessedWav({...target,frames,sampleRate:rate,settings,
      listeningTimer:{enabled:true,durationSeconds:1,fadeInSeconds:0,fadeOutSeconds:.1},
      signal:new AbortController().signal},async write=>{await write(input);});
    const output=decodePcm16Wav(await readFile(target.outputPath));
    const ceiling=10**(-6/20);
    for(const [frame,gain] of [[0,1],[1200,.75],[2400,.5],[3600,.25]] as const){
      expect(Math.abs(output.channelData[0]![frame]!-ceiling*gain)).toBeLessThanOrEqual(1/32768);
      expect(Math.abs(output.channelData[1]![frame]!+ceiling*gain/2)).toBeLessThanOrEqual(1/32768);
    }
    expect((await readFile(target.outputPath)).length).toBe(44+frames*4);
  });

  it('retains stereo linkage and exact frame count when chunks split floats and channel pairs',async()=>{
    const input=stereo([[2,-1],[2,-1],[0,0],[.125,-.25],[0,0]]);
    const whole=await destination();const split=await destination();
    for(const [target,step] of [[whole,input.length],[split,3]] as const){
      await writeProcessedWav({...target,frames:5,sampleRate:48000,settings,signal:new AbortController().signal},async write=>{
        for(let at=0;at<input.length;at+=step)await write(input.subarray(at,at+step));
      });
    }
    expect(await readFile(split.outputPath)).toEqual(await readFile(whole.outputPath));
    const decoded=decodePcm16Wav(await readFile(split.outputPath));
    expect(decoded.frames).toBe(5);expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channelData[0]![0]).toBeCloseTo(.5011872336,4);
    expect(decoded.channelData[1]![0]).toBeCloseTo(-.2505936168,4);
    expect(decoded.channelData.map(channel=>channel[2])).toEqual([0,0]);
    expect(decoded.channelData.map(channel=>channel[4])).toEqual([0,0]);
    expect(Math.abs(decoded.channelData[0]![3]!)).toBeLessThan(.125);
  });

  it('uses nearest-even PCM16 rounding without changing quiet frames or adding a tail',async()=>{
    const target=await destination();const input=stereo([[.5/32768,1.5/32768],[2.5/32768,-.5/32768],[-1.5/32768,-2.5/32768],[.125,-.25],[0,0]]);
    await writeProcessedWav({...target,frames:5,sampleRate:48000,settings,signal:new AbortController().signal},async write=>{await write(input);});
    const output=decodePcm16Wav(await readFile(target.outputPath));
    expect(Array.from(output.channelData[0]!).map(value=>value*32768)).toEqual([0,2,-2,4096,0]);
    expect(Array.from(output.channelData[1]!).map(value=>value*32768)).toEqual([2,0,-2,-8192,0]);
    expect((await readFile(target.outputPath)).length).toBe(44+5*4);
  });

  it('rejects incomplete, extra, and non-finite frames rather than accepting a partial export',async()=>{
    const cases=[
      {frames:2,input:stereo([[0,0]]),message:'frame count'},
      {frames:1,input:stereo([[0,0]]).subarray(0,7),message:'frame count'},
      {frames:1,input:stereo([[0,0],[0,0]]),message:'frame count'},
      {frames:1,input:stereo([[NaN,0]]),message:'Non-finite'},
      {frames:1,input:stereo([[0,Infinity]]),message:'Non-finite'},
    ];
    for(const value of cases){
      const target=await destination();
      await expect(writeProcessedWav({...target,frames:value.frames,sampleRate:48000,settings,signal:new AbortController().signal},async write=>{await write(value.input);})).rejects.toThrow(value.message);
    }
  });

  it('stops writes on cancellation and preserves unrelated or already existing files',async()=>{
    const target=await destination();const controller=new AbortController();
    await expect(writeProcessedWav({...target,frames:2,sampleRate:48000,settings,signal:controller.signal},async write=>{
      await write(stereo([[.1,-.2]]));controller.abort();await write(stereo([[.1,-.2]]));
    })).rejects.toMatchObject({name:'AbortError'});
    const partial=await readFile(target.outputPath);expect(partial.length).toBe(48);
    await expect(writeProcessedWav({...target,frames:2,sampleRate:48000,settings,signal:new AbortController().signal},async()=>{})).rejects.toMatchObject({code:'EEXIST'});
    expect(await readFile(target.outputPath)).toEqual(partial);
    const before=await destination();const canceled=new AbortController();canceled.abort();
    await expect(writeProcessedWav({...before,frames:1,sampleRate:48000,settings,signal:canceled.signal},async()=>{})).rejects.toMatchObject({name:'AbortError'});
    expect(await readdir(before.root)).toEqual([]);
  });
});
