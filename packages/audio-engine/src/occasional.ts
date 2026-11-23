import type {Layer} from '@asmr-studio/contracts';

export const OCCASIONAL_SAMPLE_RATE = 48_000;

export interface OccasionalEvent {
  index:number;
  assetId:string;
  startFrame:number;
  endFrame:number;
  gain:number;
  pan:number;
}

const WORD = 0x1_0000_0000;

function checkedFrame(value:number):number {
  if (!Number.isSafeInteger(value)) throw new RangeError('Occasional timing exceeds the supported frame range');
  return value;
}

// Fixed unsigned 32-bit avalanche; include both words of the block number for long sessions.
function mix(word:number):number {
  word = Math.imul(word ^ (word >>> 16), 0x85ebca6b);
  word = Math.imul(word ^ (word >>> 13), 0xc2b2ae35);
  return (word ^ (word >>> 16)) >>> 0;
}

function random(blockKey:number, domain:number, slot:number):number {
  return mix(blockKey ^ mix(domain) ^ mix(slot + 16)) / WORD;
}

function shuffled(ids:string[], blockKey:number, half:number):string[] {
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random(blockKey, half + 1, i) * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

export function createOccasionalSchedule(layer:Pick<Layer,'assetId'|'startSeconds'|'occasional'>, durations:ReadonlyMap<string,number>) {
  const settings = layer.occasional;
  if (!settings?.enabled) throw new RangeError('An enabled occasional layer is required');
  const {seed,minPauseSeconds,maxPauseSeconds,alternateAssetIds,levelVariation,panVariation} = settings;
  const ids = [layer.assetId,...alternateAssetIds];
  if (ids.length > 8 || new Set(ids).size !== ids.length) throw new RangeError('Invalid occasional asset list');
  if (!(layer.startSeconds >= 0 && minPauseSeconds >= .25 && maxPauseSeconds >= minPauseSeconds && maxPauseSeconds <= 3600))
    throw new RangeError('Invalid occasional timing');
  const origin = checkedFrame(Math.round(layer.startSeconds * OCCASIONAL_SAMPLE_RATE));
  const minPause = Math.round(minPauseSeconds * OCCASIONAL_SAMPLE_RATE);
  const maxPause = Math.round(maxPauseSeconds * OCCASIONAL_SAMPLE_RATE);
  const lengths = new Map<string,number>();
  let total = 0;
  for (const id of ids) {
    const seconds = durations.get(id);
    if (seconds === undefined || !(seconds > 0)) throw new RangeError('Missing or invalid occasional asset duration: ' + id);
    const length = Math.max(1,checkedFrame(Math.round(seconds * OCCASIONAL_SAMPLE_RATE)));
    lengths.set(id,length);
    total += length;
  }
  // Each block contains two shuffles of the pool. A pause in the first shuffle and
  // its partner in the second sum to min+max, so every block has the same length.
  const blockLength = checkedFrame(2 * total + ids.length * (minPause + maxPause));
  const slots = 2 * ids.length;

  function* events(fromSeconds:number,toSeconds:number):IterableIterator<OccasionalEvent> {
    const fromFrame = checkedFrame(Math.round(fromSeconds * OCCASIONAL_SAMPLE_RATE));
    checkedFrame(Math.round(toSeconds * OCCASIONAL_SAMPLE_RATE));
    if (toSeconds <= fromSeconds || toSeconds <= origin / OCCASIONAL_SAMPLE_RATE) return;
    let block = Math.floor(Math.max(0,fromFrame - origin) / blockLength);
    // Rounded lookup can land on the next block for a fractional-frame query.
    if (block > 0 && (origin + block * blockLength) / OCCASIONAL_SAMPLE_RATE > fromSeconds) block--;
    let cursor = checkedFrame(origin + block * blockLength);
    while (cursor / OCCASIONAL_SAMPLE_RATE < toSeconds) {
      const blockKey = mix(seed ^ mix(block >>> 0) ^ mix(Math.floor(block / WORD) + 0x9e3779b9));
      for (let half = 0; half < 2; half++) {
        const order = shuffled(ids,blockKey,half);
        for (const [position,assetId] of order.entries()) {
          if (cursor / OCCASIONAL_SAMPLE_RATE >= toSeconds) return;
          const endFrame = checkedFrame(cursor + lengths.get(assetId)!);
          const slot = half * ids.length + position;
          if (endFrame / OCCASIONAL_SAMPLE_RATE > fromSeconds) {
            const gain = Math.fround(1 - levelVariation * random(blockKey,4,slot));
            const pan = Math.fround(panVariation * (2 * random(blockKey,5,slot) - 1));
            // At a non-float32 limit round inward, preserving the configured range.
            yield {index:block * slots + slot,assetId,startFrame:cursor,endFrame,
              gain:gain < 1 - levelVariation ? Math.fround(gain + 2 ** -24) : gain,
              pan:Math.abs(pan) > panVariation ? Math.fround(pan * (1 - 2 ** -23)) : pan || 0};
          }
          const offset = Math.floor(random(blockKey,3,position) * (maxPause - minPause + 1));
          cursor = checkedFrame(endFrame + (half === 0 ? minPause + offset : maxPause - offset));
        }
      }
      block++;
    }
  }
  return {events};
}
