import type {AssetRecord} from '@asmr-studio/contracts';

export interface LoopWaveform {
  durationSeconds:number;
  sampleRate:number;
  frameCount:number;
  min:Float32Array;
  max:Float32Array;
}
const memoryLimit = 64 * 1024 * 1024;
const scanSlice = 262144;

export async function buildWaveform(buffer:AudioBuffer, signal:AbortSignal):Promise<LoopWaveform> {
  signal.throwIfAborted();
  const bins = Math.min(1024, buffer.length);
  const min = new Float32Array(bins).fill(Infinity);
  const max = new Float32Array(bins).fill(-Infinity);
  let remaining = scanSlice;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let bin = 0; bin < bins; bin++) {
      const end = Math.floor((bin + 1) * buffer.length / bins);
      for (let frame = Math.floor(bin * buffer.length / bins); frame < end;) {
        const count = Math.min(remaining, end - frame);
        const stop = frame + count;
        let low = min[bin]!, high = max[bin]!;
        while (frame < stop) {
          const value = samples[frame++]!;
          if (value < low) low = value;
          if (value > high) high = value;
        }
        min[bin] = low;
        max[bin] = high;
        remaining -= count;
        if (remaining === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          signal.throwIfAborted();
          remaining = scanSlice;
        }
      }
    }
  }
  return {durationSeconds:buffer.length / buffer.sampleRate, sampleRate:buffer.sampleRate,
    frameCount:buffer.length, min, max};
}

function overBudget() {
  return new Error('This recording exceeds the loop editor memory limit. Use the numeric loop controls.');
}

async function readEncoded(response:Response, signal:AbortSignal):Promise<ArrayBuffer> {
  if (!response.ok) throw new Error('The recording is unavailable.');
  if (Number(response.headers.get('content-length')) > memoryLimit) {
    await response.body?.cancel();
    throw overBudget();
  }
  if (!response.body) throw new Error('The recording has no readable audio.');
  const reader = response.body.getReader();
  const chunks:Uint8Array[] = [];
  let total = 0;
  const cancel = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', cancel, {once:true});
  try {
    while (true) {
      signal.throwIfAborted();
      const {done,value} = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.length;
      if (total > memoryLimit) {
        await reader.cancel();
        throw overBudget();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort',cancel);
    reader.releaseLock();
  }
  const encoded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {encoded.set(chunk,offset); offset += chunk.length;}
  return encoded.buffer;
}

interface Options {
  getDecodedAsset?:(id:string)=>AudioBuffer|Promise<AudioBuffer>|undefined;
  createContext?:()=>AudioContext;
  fetch?:typeof fetch;
}

export function createLoopAudioService(options:Options = {}) {
  let ownedContext:AudioContext|undefined;
  let disposed = false;
  let session = new AbortController();
  let selected:string|undefined;
  let current:AudioBuffer|undefined;
  let decodeQueue = Promise.resolve();
  const peaks = new Map<string,LoopWaveform>();

  function release() {
    session.abort();
    session = new AbortController();
    selected = undefined;
    current = undefined;
  }
  function context() {
    if (disposed) throw new Error('The loop audio service is closed.');
    return ownedContext ??= options.createContext?.() ?? new AudioContext();
  }
  async function acquire(asset:AssetRecord, signal:AbortSignal) {
    signal.throwIfAborted();
    if (disposed) throw new Error('The loop audio service is closed.');
    if (selected === asset.id && current) return current;
    release();
    selected = asset.id;
    const active = AbortSignal.any([signal, session.signal]);
    const borrowed = options.getDecodedAsset?.(asset.id);
    let buffer:AudioBuffer;
    if (borrowed) {
      buffer = await borrowed;
    } else {
      const decode = async () => {
        active.throwIfAborted();
        const audio = context();
        if (Math.ceil(asset.durationSeconds * audio.sampleRate) * asset.channels * 4 > memoryLimit) throw overBudget();
        const response = await (options.fetch ?? fetch)('/api/assets/'+encodeURIComponent(asset.id)+'/content',
          {credentials:'same-origin',signal:active});
        const bytes = await readEncoded(response,active);
        active.throwIfAborted();
        const decoded = await audio.decodeAudioData(bytes);
        active.throwIfAborted();
        if (decoded.length * decoded.numberOfChannels * 4 > memoryLimit) throw overBudget();
        return decoded;
      };
      const pending = decodeQueue.then(decode);
      decodeQueue = pending.then(() => {}, () => {});
      buffer = await pending;
    }
    active.throwIfAborted();
    current = buffer;
    return buffer;
  }
  async function waveform(asset:AssetRecord, buffer:AudioBuffer, signal:AbortSignal) {
    const active = AbortSignal.any([signal,session.signal]);
    active.throwIfAborted();
    if (disposed) throw new Error('The loop audio service is closed.');
    const key = [asset.sha256,buffer.sampleRate,buffer.length].join('/');
    const cached = peaks.get(key);
    if (cached) {peaks.delete(key); peaks.set(key,cached); return cached;}
    const result = await buildWaveform(buffer,active);
    active.throwIfAborted();
    peaks.set(key,result);
    if (peaks.size > 16) peaks.delete(peaks.keys().next().value!);
    return result;
  }
  return {context, acquire, waveform, peek:(id:string) => selected === id ? current : undefined, release,
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
      peaks.clear();
      if (ownedContext) void ownedContext.close().catch(() => {});
      ownedContext = undefined;
    }};
}

export type LoopAudioService = ReturnType<typeof createLoopAudioService>;
