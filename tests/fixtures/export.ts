import {wavFixture} from './audio.js';

export const EXPORT_FIXTURE_RATE = 48_000;
export const PCM16_QUANTUM = 1 / 32_768;

/** Conservative multitone input for checking low, mid and high EQ response independently. */
export function exportToneFixture(options:{frames:number;channels:1|2;frequencies:readonly number[];amplitude?:number}):Uint8Array {
  const bytes=wavFixture({...options,sampleRate:EXPORT_FIXTURE_RATE});
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const amplitude=options.amplitude??0.025;
  for(let frame=0;frame<options.frames;frame++)for(let channel=0;channel<options.channels;channel++){
    const value=options.frequencies.reduce((sum,frequency)=>sum+Math.sin(2*Math.PI*frequency*frame/EXPORT_FIXTURE_RATE+channel*Math.PI/7),0)*amplitude/(channel+1);
    view.setInt16(44+(frame*options.channels+channel)*2,Math.round(value*32768),true);
  }
  return bytes;
}

export function toneAmplitude(samples:Float32Array,frequency:number,start:number,end:number):number {
  let real=0,imaginary=0;
  for(let frame=start;frame<end;frame++){
    const angle=2*Math.PI*frequency*frame/EXPORT_FIXTURE_RATE;
    real+=samples[frame]!*Math.cos(angle);imaginary+=samples[frame]!*Math.sin(angle);
  }
  return 2*Math.hypot(real,imaginary)/(end-start);
}

/** Distinct, varying channels expose wrong pan matrices, offsets and loop periods. */
export function exportSignalFixture(options:{frames:number;channels:1|2;seed:number}):Uint8Array {
  const bytes = wavFixture({...options,sampleRate:EXPORT_FIXTURE_RATE});
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for (let frame = 0; frame < options.frames; frame++) {
    const time = frame / EXPORT_FIXTURE_RATE;
    for (let channel = 0; channel < options.channels; channel++) {
      const frequency = 137 + options.seed * 29;
      const value = channel === 0
        ? 0.16 * Math.sin(2 * Math.PI * frequency * time) + 0.055 * Math.cos(2 * Math.PI * 73 * time) + 0.025
        : -0.11 * Math.sin(2 * Math.PI * (frequency + 83) * time) + 0.045 * Math.cos(2 * Math.PI * 109 * time) - 0.035;
      view.setInt16(44 + (frame * options.channels + channel) * 2,Math.round(value * 32_768),true);
    }
  }
  return bytes;
}

export interface DecodedPcm16 {
  sampleRate:number;
  frames:number;
  channelData:Float32Array[];
}

/** Read real RIFF chunks: FFmpeg may add LIST/fmt extensions before the PCM data. */
export function decodePcm16Wav(bytes:Uint8Array):DecodedPcm16 {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const text = (offset:number,length:number) => String.fromCharCode(...bytes.subarray(offset,offset + length));
  if (bytes.byteLength < 44 || text(0,4) !== 'RIFF' || text(8,4) !== 'WAVE') throw new Error('Expected a finished RIFF/WAVE file');
  if (view.getUint32(4,true) + 8 !== bytes.byteLength) throw new Error('RIFF size does not match the complete downloaded file');
  let format:{channels:number;sampleRate:number;blockAlign:number}|undefined;
  let data:{offset:number;bytes:number}|undefined;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const tag = text(offset,4);
    const length = view.getUint32(offset + 4,true);
    const content = offset + 8;
    if (content + length > bytes.byteLength) throw new Error(`Truncated ${tag} chunk`);
    if (tag === 'fmt ') {
      if (length < 16) throw new Error('Truncated WAV format');
      const encoding = view.getUint16(content,true);
      const channels = view.getUint16(content + 2,true);
      const sampleRate = view.getUint32(content + 4,true);
      const blockAlign = view.getUint16(content + 12,true);
      const bits = view.getUint16(content + 14,true);
      const pcmGuid = [1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113];
      const extendedPcm = encoding === 0xfffe && length >= 40
        && view.getUint16(content + 16,true) >= 22 && view.getUint16(content + 18,true) === 16
        && pcmGuid.every((value,index) => view.getUint8(content + 24 + index) === value);
      if ((encoding !== 1 && !extendedPcm) || bits !== 16) throw new Error('Expected signed PCM16 WAV');
      if (channels < 1 || blockAlign !== channels * 2 || view.getUint32(content + 8,true) !== sampleRate * blockAlign) {
        throw new Error('Invalid PCM16 frame layout');
      }
      format = {channels,sampleRate,blockAlign};
    }
    if (tag === 'data') {
      if (data) throw new Error('Unexpected duplicate PCM data chunk');
      data = {offset:content,bytes:length};
    }
    offset = content + length + length % 2;
  }
  if (!format || !data || data.bytes % format.blockAlign !== 0) throw new Error('Missing or incomplete PCM16 frames');
  const frames = data.bytes / format.blockAlign;
  const channelData = Array.from({length:format.channels},() => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < format.channels; channel++) {
    channelData[channel]![frame] = view.getInt16(data.offset + frame * format.blockAlign + channel * 2,true) / 32_768;
  }
  return {sampleRate:format.sampleRate,frames,channelData};
}

export function samplePeak(samples:readonly number[]|Float32Array,from=0,to=samples.length):number {
  let peak = 0;
  for (let frame = from; frame < to; frame++) peak = Math.max(peak,Math.abs(samples[frame]!));
  return peak;
}

export function pcm16ErrorMetrics(actual:Float32Array,reference:readonly number[]) {
  if (actual.length !== reference.length || actual.length === 0) throw new Error('Parity comparison requires equal nonempty channel lengths');
  let maxErrorPcm16 = 0;
  let squaredErrorPcm16 = 0;
  let worstFrame = 0;
  for (let frame = 0; frame < actual.length; frame++) {
    const error = Math.abs(actual[frame]! - reference[frame]!) / PCM16_QUANTUM;
    if (!Number.isFinite(error)) throw new Error(`Nonfinite sample at frame ${frame}`);
    if (error > maxErrorPcm16) { maxErrorPcm16 = error; worstFrame = frame; }
    squaredErrorPcm16 += error * error;
  }
  const sampleWindow = [];
  for (let frame = Math.max(0,worstFrame - 4); frame <= Math.min(actual.length - 1,worstFrame + 4); frame++) {
    sampleWindow.push({frame,native:actual[frame],browser:reference[frame],errorPcm16:(actual[frame]! - reference[frame]!) / PCM16_QUANTUM});
  }
  return {
    maxErrorPcm16,rmsErrorPcm16:Math.sqrt(squaredErrorPcm16 / actual.length),worstFrame,
    worstAtSeconds:worstFrame / EXPORT_FIXTURE_RATE,sampleWindow,
  };
}
