import {listeningEnvelopeGain,StereoOutputProcessor} from '@asmr-studio/audio-engine';
import {listeningDuration,transitionBlendAt,type MixScene,type Scene} from '@asmr-studio/contracts';
import {OUTPUT_STREAM_BUFFER_BYTES,writeProcessedWav} from './output-wav.js';

const blockFrames=1024;
// Final WAV processing plus the four-channel pipe, side processors, envelopes, and stereo handoff.
export const TRANSITION_OUTPUT_STREAM_BUFFER_BYTES=OUTPUT_STREAM_BUFFER_BYTES+3*65536+blockFrames*32;
interface TransitionWavOptions {
  outputPath:string;
  frames:number;
  sampleRate:number;
  scene:Scene;
  signal:AbortSignal;
  /** Actual decoded source ends when a side has no explicit timer or endless layer. */
  sideEndSeconds?:readonly [number,number];
}
type Consumer=(chunk:Buffer)=>Promise<void>;

function checkAbort(signal:AbortSignal):void {
  if(signal.aborted){const error=new Error('Export canceled');error.name='AbortError';throw error;}
}
function sideEnvelope(scene:MixScene,elapsed:number,endpoint:number):number {
  if(elapsed>=endpoint)return 0;
  return listeningEnvelopeGain(scene.listeningTimer,elapsed,endpoint);
}

/** A/B retain their own output state before the crossfader and one final PCM conversion. */
export async function writeTransitionWav(options:TransitionWavOptions,produce:(write:Consumer)=>Promise<void>):Promise<void> {
  const {scene,frames,sampleRate,signal}=options;
  const transition=scene.transition;
  if(!transition?.a||!transition.b)throw new Error('A transition export requires both captured mixes');
  checkAbort(signal);
  const sides=[transition.a.scene,transition.b.scene] as const;
  const endpoints=options.sideEndSeconds??sides.map(side=>listeningDuration(side.listeningTimer,side.durationSeconds)??Infinity);
  const processors=sides.map(side=>{const processor=new StereoOutputProcessor(sampleRate);processor.setLimiter(side.outputLimiter,false);return processor;});
  const channels=Array.from({length:4},()=>new Float32Array(blockFrames));
  const envelopes=[new Float32Array(blockFrames),new Float32Array(blockFrames)] as const;
  const stereo=Buffer.allocUnsafe(blockFrames*8),remainder=Buffer.allocUnsafe(16);
  const master=Math.fround(scene.masterGain);
  let received=0,written=0,pending=0;
  await writeProcessedWav({outputPath:options.outputPath,frames,sampleRate,settings:scene.outputLimiter,signal},async consume=>{
    await produce(async chunk=>{
      checkAbort(signal);received+=chunk.length;
      if(received>frames*16)throw new Error('Transition input has an incorrect frame count');
      let offset=0,count=0;
      const flush=async()=>{
        if(count===0)return;
        checkAbort(signal);
        for(let side=0;side<2;side++){
          const left=channels[side*2]!.subarray(0,count),right=channels[side*2+1]!.subarray(0,count);
          const gain=envelopes[side]!;
          for(let frame=0;frame<count;frame++)gain[frame]=sideEnvelope(sides[side]!, (written+frame)/sampleRate,endpoints[side]!);
          processors[side]!.process(left,right,left,right,gain.subarray(0,count));
        }
        for(let frame=0;frame<count;frame++){
          const blend=transitionBlendAt(transition,(written+frame)/sampleRate);
          const gainA=Math.fround(1-blend),gainB=Math.fround(blend);
          for(let channel=0;channel<2;channel++){
            const combined=Math.fround(Math.fround(channels[channel]![frame]!*gainA)+Math.fround(channels[channel+2]![frame]!*gainB));
            stereo.writeFloatLE(Math.fround(combined*master),frame*8+channel*4);
          }
        }
        await consume(stereo.subarray(0,count*8));written+=count;count=0;
      };
      while(offset<chunk.length){
        let source=chunk,start=offset;
        if(pending>0||chunk.length-offset<16){
          const take=Math.min(16-pending,chunk.length-offset);
          chunk.copy(remainder,pending,offset,offset+take);pending+=take;offset+=take;
          if(pending<16)break;
          source=remainder;start=0;pending=0;
        }else offset+=16;
        for(let channel=0;channel<4;channel++){
          const value=source.readFloatLE(start+channel*4);
          if(!Number.isFinite(value))throw new Error('Non-finite transition export audio');
          channels[channel]![count]=value;
        }
        count++;
        if(count===blockFrames)await flush();
      }
      await flush();
    });
    checkAbort(signal);
    if(pending!==0||received!==frames*16||written!==frames)throw new Error('Transition input has an incorrect frame count');
  });
}
