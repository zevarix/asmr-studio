import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyScene,createEmptyTransition,type Scene} from '@asmr-studio/contracts';
import {decodePcm16Wav} from '../../../tests/fixtures/export.js';
import {writeTransitionWav} from './transition-output-wav.js';

const roots:string[]=[];
async function destination(){const root=await mkdtemp(join(tmpdir(),'asmr-transition-wav-'));roots.push(root);return {root,outputPath:join(root,'transition.wav')};}
function scene():Scene {
  const value=createEmptyTransition('transition','Transition');
  value.outputLimiter={enabled:false,ceilingDb:-1};
  value.transition!.a={id:'capture-a',scene:{...createEmptyScene('a','A'),revision:1,masterGain:1},assets:[]};
  value.transition!.b={id:'capture-b',scene:{...createEmptyScene('b','B'),revision:1,masterGain:1},assets:[]};
  return value;
}
function quad(frames:number,values:readonly [number,number,number,number]):Buffer {
  const bytes=Buffer.alloc(frames*16);
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<4;channel++)bytes.writeFloatLE(values[channel]!,frame*16+channel*4);
  return bytes;
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('bounded four-channel transition processing',()=>{
  it('preserves channel identity and the timed hold, ramp and endpoint through split samples and blocks',async()=>{
    const value=scene(),frames=8401,rate=48000,input=quad(frames,[.25,-.5,.75,.5]);
    Object.assign(value.transition!,{mode:'timed',blend:.2,startSeconds:.025,durationSeconds:.1});
    const whole=await destination(),split=await destination();
    for(const [target,step] of [[whole,input.length],[split,4091]] as const){
      await writeTransitionWav({...target,scene:value,frames,sampleRate:rate,signal:new AbortController().signal},async write=>{
        for(let at=0;at<input.length;at+=step)await write(input.subarray(at,at+step));
      });
    }
    expect(await readFile(split.outputPath)).toEqual(await readFile(whole.outputPath));
    const output=decodePcm16Wav(await readFile(split.outputPath));
    expect(output.frames).toBe(frames);
    for(const [time,blend] of [[0,.2],[.025,.2],[.05,.4],[.075,.6],[.1,.8],[.125,1],[.175,1]] as const){
      const at=Math.round(time*rate);
      expect(Math.abs(output.channelData[0]![at]!-(.25*(1-blend)+.75*blend))).toBeLessThanOrEqual(1/32768);
      expect(Math.abs(output.channelData[1]![at]!-(-.5*(1-blend)+.5*blend))).toBeLessThanOrEqual(1/32768);
    }
  });

  it('applies side limiting before its saved timer and blend without extending its deadline to the file end',async()=>{
    const target=await destination(),value=scene(),frames=4800,rate=48000;
    value.transition!.blend=.5;
    const a=value.transition!.a!.scene;
    a.outputLimiter={enabled:true,ceilingDb:-6};
    a.listeningTimer={enabled:true,durationSeconds:.05,fadeInSeconds:.01,fadeOutSeconds:.02};
    const input=quad(frames,[2,-1,.2,.4]);
    await writeTransitionWav({...target,scene:value,frames,sampleRate:rate,signal:new AbortController().signal},async write=>{await write(input);});
    const output=decodePcm16Wav(await readFile(target.outputPath)),ceiling=10**(-6/20);
    for(const [time,gain] of [[0,0],[.005,.5],[.02,1],[.04,.5],[.05,0],[.075,0]] as const){
      const frame=Math.round(time*rate);
      expect(Math.abs(output.channelData[0]![frame]!-(ceiling*gain*.5+.1))).toBeLessThanOrEqual(1/32768);
      expect(Math.abs(output.channelData[1]![frame]!-(-ceiling*gain*.25+.2))).toBeLessThanOrEqual(1/32768);
    }
  });

  it('limits the unclipped combined mix once, retaining stereo linkage and sub-PCM input precision',async()=>{
    const target=await destination(),value=scene();value.transition!.blend=.5;value.outputLimiter={enabled:true,ceilingDb:-6};
    await writeTransitionWav({...target,scene:value,frames:1,sampleRate:48000,signal:new AbortController().signal},async write=>{await write(quad(1,[2,-1,2,-1]));});
    const output=decodePcm16Wav(await readFile(target.outputPath));
    expect(output.channelData[0]![0]).toBeCloseTo(10**(-6/20),4);
    expect(output.channelData[1]![0]).toBeCloseTo(-(10**(-6/20))/2,4);
    const quiet=await destination();value.outputLimiter!.enabled=false;
    await writeTransitionWav({...quiet,scene:value,frames:1,sampleRate:48000,signal:new AbortController().signal},async write=>{
      await write(quad(1,[.6/32768,0,1.6/32768,0]));
    });
    expect(decodePcm16Wav(await readFile(quiet.outputPath)).channelData[0]![0]!*32768).toBe(1);
  });

  it('rejects missing, partial, extra and nonfinite frames and never calls a producer after early cancellation',async()=>{
    for(const input of [quad(1,[0,0,0,0]).subarray(0,15),Buffer.alloc(0),quad(2,[0,0,0,0]),quad(1,[0,NaN,0,0]),quad(1,[0,0,Infinity,0])]){
      const target=await destination();
      await expect(writeTransitionWav({...target,scene:scene(),frames:1,sampleRate:48000,signal:new AbortController().signal},async write=>{await write(input);})).rejects.toThrow();
    }
    const target=await destination(),controller=new AbortController();controller.abort();let called=false;
    await expect(writeTransitionWav({...target,scene:scene(),frames:1,sampleRate:48000,signal:controller.signal},async()=>{called=true;})).rejects.toMatchObject({name:'AbortError'});
    expect(called).toBe(false);expect(await readdir(target.root)).toEqual([]);
  });

  it('propagates cancellation between chunks to the owned producer',async()=>{
    const target=await destination(),controller=new AbortController();let rejected=false;
    await expect(writeTransitionWav({...target,scene:scene(),frames:2,sampleRate:48000,signal:controller.signal},async write=>{
      await write(quad(1,[.1,.2,.3,.4]));controller.abort();
      try {await write(quad(1,[.1,.2,.3,.4]));} catch(error) {rejected=true;throw error;}
    })).rejects.toMatchObject({name:'AbortError'});
    expect(rejected).toBe(true);expect((await readFile(target.outputPath)).length).toBe(48);
  });
});
