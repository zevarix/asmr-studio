import {describe,expect,it} from 'vitest';
import {createOccasionalSchedule,OCCASIONAL_SAMPLE_RATE as rate} from './occasional.js';

const settings = {enabled:true, seed:123,minPauseSeconds:.25,maxPauseSeconds:.75,alternateAssetIds:['b'],levelVariation:.2,panVariation:.15};
const lengths = new Map([['a',1],['b',.5],['c',.125]]);
function schedule(overrides:Partial<typeof settings> = {}, durations = lengths) {
  return createOccasionalSchedule({assetId:'a',startSeconds:1,occasional:{...settings,...overrides}},durations);
}

describe('occasional canonical schedule',()=>{
  it('pins seed, asset order, integer spans and independent modulation',()=>{
    expect([...schedule().events(0,6)]).toEqual([
      {index:0,assetId:'b',startFrame:48000,endFrame:72000,gain:.8302825689315796,pan:-.03649153932929039},
      {index:1,assetId:'a',startFrame:91356,endFrame:139356,gain:.960905134677887,pan:-.10014110058546066},
      {index:2,assetId:'b',startFrame:165853,endFrame:189853,gain:.8063774108886719,pan:-.14361749589443207},
      {index:3,assetId:'a',startFrame:218497,endFrame:266497,gain:.9953663945198059,pan:-.04439704120159149}
    ]);
    expect([...schedule({seed:124}).events(0,6)]).not.toEqual([...schedule().events(0,6)]);
  });

  it('observes half-open windows including fractional samples and gaps',()=>{
    const s = schedule(),first = s.events(0,2).next().value!;
    expect([...s.events(0,1)]).toEqual([]);
    expect([...s.events(1.5,91356 / rate)]).toEqual([]);
    expect([...s.events(1.5 - .1 / rate,1.5)]).toEqual([first]);
    expect([...s.events(6 - .1 / rate,6)]).toEqual([]);
    expect([...s.events(6 - .1 / rate,6 + .1 / rate)].map(e=>e.index)).toEqual([4]);
    expect([...s.events(1,1)]).toEqual([]);
  });

  it('uses the configured asset order and each selected clip’s length',()=>{
    const all = [...schedule({alternateAssetIds:['b','c']}).events(0,500)];
    const reversed = [...schedule({alternateAssetIds:['c','b']}).events(0,500)];
    for (const [i,event] of all.entries()) {
      expect(event.endFrame-event.startFrame).toBe(lengths.get(event.assetId)! * rate);
      expect(event.gain).toBeGreaterThanOrEqual(1-settings.levelVariation);
      expect(event.gain).toBeLessThanOrEqual(1);
      expect(Math.abs(event.pan)).toBeLessThanOrEqual(settings.panVariation);
      const previous = all[i-1];
      if (previous) {
        expect(event.startFrame-previous.endFrame).toBeGreaterThanOrEqual(.25*rate);
        expect(event.startFrame-previous.endFrame).toBeLessThanOrEqual(.75*rate);
      }
    }
    expect(all.slice(0,6).map(e=>e.assetId).sort()).toEqual(['a','a','b','b','c','c']);
    const swapped = new Map([['a','a'],['b','c'],['c','b']]);
    expect(reversed.slice(0,6).map(e=>e.assetId)).toEqual(all.slice(0,6).map(e=>swapped.get(e.assetId)));
  });

  it('handles primary-only clips, single-frame minimum, fixed pauses and zero variation',()=>{
    const s = schedule({alternateAssetIds:[],maxPauseSeconds:.25,levelVariation:0,panVariation:0},new Map([['a',1e-9]]));
    expect([...s.events(0,1.5)]).toEqual([0,1].map(i=>({
      index:i,assetId:'a',startFrame:rate+12001*i,endFrame:rate+12001*i+1,gain:1,pan:0
    })));
  });

  it('seeks directly beyond a uint32 block number and hashes the high word',()=>{
    const s = schedule();
    const block = 2 ** 32;
    const start = 1+block*5;
    const late = [...s.events(start,start+5)];
    expect(late.map(e=>e.index)).toEqual([0,1,2,3].map(i=>block*4+i));
    expect(late[0]!.startFrame).toBe(start*rate);
    expect(late.map(e=>e.pan)).not.toEqual([...s.events(1,6)].map(e=>e.pan));
    expect([...s.events(start+.25,start+.3)]).toEqual([late[0]]);
    // A huge upper limit still produces the first descriptor lazily.
    expect(s.events(0,start).next().value).toEqual(s.events(0,2).next().value);
  });

  it('rejects missing, invalid and unrepresentable durations or query times',()=>{
    for (const seconds of [NaN,Infinity,-1,0,Number.MAX_SAFE_INTEGER]) {
      expect(()=>schedule({},new Map([['a',seconds],['b',1]]))).toThrow();
    }
    expect(()=>schedule({},new Map([['a',1]]))).toThrow();
    expect(()=>schedule().events(0,Infinity).next()).toThrow();
  });
});
