import { loopSchema, parseWith, SceneValidationError, type Layer } from '@asmr-studio/contracts';
type Loop = NonNullable<Layer['loop']>;
/** The sample data needed by both browser playback and an offline renderer. */
export interface LoopAudioBuffer {
  sampleRate:number;
  length:number;
  numberOfChannels:number;
  getChannelData(channel:number):Float32Array;
}
export interface PreparedLoop<T extends LoopAudioBuffer=AudioBuffer> {
  buffer:T;
  introSeconds:number;
  originalStartSeconds:number;
  offsetBaseSeconds:number;
  periodSeconds:number;
  extraBytes:number;
}
export function getLoopFrames(buffer:Pick<LoopAudioBuffer,'sampleRate'|'length'>, input:Loop) {
  const loop = parseWith(loopSchema,input);
  const rate = buffer.sampleRate;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(buffer.length) || buffer.length < 1) {
    throw new SceneValidationError('Decoded audio must have a positive sample rate and frame count');
  }
  const start = Math.round(loop.startSeconds * rate);
  const end = Math.round(loop.endSeconds * rate);
  const crossfade = Math.round(loop.crossfadeSeconds * rate);
  const length = end - start;
  if (start < 0 || end > buffer.length || length < 1 || crossfade > Math.floor(length / 2)) {
    throw new SceneValidationError('Loop boundaries are outside the decoded audio or shorter than one sample');
  }
  return {rate,start,end,crossfade,length,period:length-crossfade};
}
export function loopExtraBytes(buffer:LoopAudioBuffer,loop:Loop):number {
  const value = getLoopFrames(buffer,loop);
  return value.crossfade === 0 ? 0 : value.period * buffer.numberOfChannels * 4;
}

/** Copy a contiguous range of the repeated period, excluding the one-time intro. */
function writePeriodRange(source:Float32Array, output:Float32Array, frames:ReturnType<typeof getLoopFrames>,
    phase:number, offset:number, count:number):void {
  const {start,end,crossfade,period}=frames;
  const directLength=period-crossfade;
  const directCount=Math.max(0,Math.min(count,directLength-phase));
  if (directCount>0) {
    const from=start+crossfade+phase;
    output.set(source.subarray(from,from+directCount),offset);
  }
  for(let i=directCount;i<count;i++) {
    const index=phase+i-directLength;
    const incomingWeight=(index+1)/crossfade;
    output[offset+i]=source[end-crossfade+index]!*(1-incomingWeight)+source[start+index]!*incomingWeight;
  }
}

/** A finite two-second excerpt centered on the actual repeated-period wrap. */
export function createLoopJoinPreview<T extends LoopAudioBuffer>(buffer:T, loop:Loop,
    createBuffer:(channels:number,length:number,rate:number)=>T):T {
  const frames=getLoopFrames(buffer,loop);
  const {rate,period}=frames;
  const side=Math.round(rate);
  const preview=createBuffer(buffer.numberOfChannels,side*2,rate);
  const firstPhase=(period-side%period)%period;
  for(let channel=0;channel<buffer.numberOfChannels;channel++) {
    const source=buffer.getChannelData(channel);
    const output=preview.getChannelData(channel);
    const firstCount=Math.min(period-firstPhase,output.length);
    writePeriodRange(source,output,frames,firstPhase,0,firstCount);
    const secondCount=Math.min(firstPhase,output.length-firstCount);
    writePeriodRange(source,output,frames,0,firstCount,secondCount);
    // Double the rendered prefix for tiny periods, including single-frame loops.
    for(let filled=firstCount+secondCount;filled<output.length;filled*=2) {
      output.copyWithin(filled,0,Math.min(filled,output.length-filled));
    }
  }
  return preview;
}

/** A native-loop period plus an unchanged one-time intro, with linear tail/head overlap. */
export function prepareLoop<T extends LoopAudioBuffer>(buffer:T,loop:Loop,createBuffer:(channels:number,length:number,rate:number)=>T):PreparedLoop<T> {
  const frames = getLoopFrames(buffer,loop);
  const {rate,start,crossfade,period} = frames;
  if (crossfade === 0) return {buffer,introSeconds:0,originalStartSeconds:start/rate,offsetBaseSeconds:start/rate,periodSeconds:period/rate,extraBytes:0};
  const repeated = createBuffer(buffer.numberOfChannels,period,rate);
  for (let channel=0;channel<buffer.numberOfChannels;channel++) {
    writePeriodRange(buffer.getChannelData(channel),repeated.getChannelData(channel),frames,0,0,period);
  }
  return {buffer:repeated,introSeconds:crossfade/rate,originalStartSeconds:start/rate,offsetBaseSeconds:0,periodSeconds:period/rate,extraBytes:period*buffer.numberOfChannels*4};
}
