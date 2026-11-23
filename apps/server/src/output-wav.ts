import {open} from 'node:fs/promises';
import {listeningEnvelopeGain,StereoOutputProcessor} from '@asmr-studio/audio-engine';
import {listeningFadeError,type ListeningTimerSettings,type OutputLimiterSettings} from '@asmr-studio/contracts';

const blockFrames=1024;
// Includes the pipe read block, channel/PCM buffers, optional fade block, and stream overhead.
export const OUTPUT_STREAM_BUFFER_BYTES=3*65536+blockFrames*4;
interface ProcessedWavOptions {
  outputPath:string;
  frames:number;
  sampleRate:number;
  settings:OutputLimiterSettings|undefined;
  listeningTimer?:ListeningTimerSettings|undefined;
  signal:AbortSignal;
}
type Consumer=(chunk:Buffer)=>Promise<void>;

function checkAbort(signal:AbortSignal):void {
  if(signal.aborted){const error=new Error('Export canceled');error.name='AbortError';throw error;}
}

/** Match the default float-to-PCM16 nearest-even conversion, without dither or makeup gain. */
function pcm16(sample:number):number {
  const scaled=sample*32768;const lower=Math.floor(scaled);const fraction=scaled-lower;
  const rounded=fraction===.5?(lower%2===0?lower:lower+1):Math.round(scaled);
  return Math.max(-32768,Math.min(32767,rounded));
}

/** The producer owns/reaps its process. A consumer failure must stop that producer. */
export async function writeProcessedWav(options:ProcessedWavOptions,produce:(write:Consumer)=>Promise<void>):Promise<void> {
  const {outputPath,frames,sampleRate,settings,listeningTimer,signal}=options;
  checkAbort(signal);
  if(!Number.isSafeInteger(frames)||frames<1||frames*4+36>0xffff_ffff)throw new Error('Invalid processed WAV frame count');
  if(!Number.isSafeInteger(sampleRate)||sampleRate<=0||sampleRate*4>0xffff_ffff)throw new Error('Invalid processed WAV sample rate');
  const endpoint=frames/sampleRate,fadeError=listeningFadeError(listeningTimer,endpoint);
  if(fadeError)throw new Error(fadeError);
  const processor=new StereoOutputProcessor(sampleRate);processor.setLimiter(settings,false);
  const left=new Float32Array(blockFrames),right=new Float32Array(blockFrames);
  const gain=listeningTimer?.enabled&&(listeningTimer.fadeInSeconds>0||listeningTimer.fadeOutSeconds>0)?new Float32Array(blockFrames):undefined;
  const bytes=Buffer.allocUnsafe(blockFrames*4);const remainder=Buffer.allocUnsafe(8);
  let received=0,written=0,pending=0;
  const output=await open(outputPath,'wx',0o600);
  try{
    const header=Buffer.alloc(44);
    header.write('RIFF',0);header.writeUInt32LE(frames*4+36,4);header.write('WAVEfmt ',8);
    header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);
    header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*4,28);
    header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(frames*4,40);
    await output.writeFile(header);
    await produce(async chunk=>{
      checkAbort(signal);received+=chunk.length;
      if(received>frames*8)throw new Error('Processed WAV input has an incorrect frame count');
      let offset=0,count=0;
      const flush=async()=>{
        if(count===0)return;
        checkAbort(signal);
        const l=left.subarray(0,count),r=right.subarray(0,count);
        if(gain)for(let frame=0;frame<count;frame++)gain[frame]=listeningEnvelopeGain(listeningTimer,(written+frame)/sampleRate,endpoint);
        processor.process(l,r,l,r,gain?.subarray(0,count));
        for(let frame=0;frame<count;frame++){
          bytes.writeInt16LE(pcm16(left[frame]!),frame*4);bytes.writeInt16LE(pcm16(right[frame]!),frame*4+2);
        }
        await output.writeFile(bytes.subarray(0,count*4));written+=count;count=0;
      };
      while(offset<chunk.length){
        let source=chunk,start=offset;
        if(pending>0||chunk.length-offset<8){
          const take=Math.min(8-pending,chunk.length-offset);
          chunk.copy(remainder,pending,offset,offset+take);pending+=take;offset+=take;
          if(pending<8)break;
          source=remainder;start=0;pending=0;
        }else offset+=8;
        const l=source.readFloatLE(start),r=source.readFloatLE(start+4);
        if(!Number.isFinite(l)||!Number.isFinite(r))throw new Error('Non-finite mixed export audio');
        left[count]=l;right[count]=r;count++;
        if(count===blockFrames)await flush();
      }
      await flush();
    });
    checkAbort(signal);
    if(pending!==0||received!==frames*8||written!==frames)throw new Error('Processed WAV input has an incorrect frame count');
  }finally{await output.close();}
}
