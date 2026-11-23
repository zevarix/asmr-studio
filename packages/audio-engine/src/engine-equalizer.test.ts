import {afterEach, describe, expect, it} from 'vitest';
import {flatEqualizer, type EqualizerSettings} from '@asmr-studio/contracts';
import {createMixer} from './engine.js';
import type {Mixer, PlaybackSnapshot} from './types.js';
import {FakeContext, FakeNode, fakeBuffer} from './test-utils/fake-context.js';
import {fixtureLayer, fixtureScene} from '../../../tests/fixtures/scene.js';

const mixers: Mixer[] = [];
function create(context = new FakeContext(), loadAsset = async (_id: string) => fakeBuffer(2, 480_000)) {
  const mixer = createMixer({context: context as unknown as AudioContext, loadAsset, decodedBudgetBytes: 20_000_000});
  mixers.push(mixer);
  let current!: PlaybackSnapshot;
  mixer.subscribe(value => { current = value; });
  return {context, mixer, snapshot: () => current};
}
afterEach(() => mixers.splice(0).forEach(mixer => mixer.dispose()));
const shaped: EqualizerSettings = {bassDb: 6, midDb: -3, trebleDb: 2, bypassed: false};

describe('live equalizer graph', () => {
  it('keeps legacy settings flat and routes envelope, layer EQ, gain, pan, master EQ, gain, analyser in order', async () => {
    const {context, mixer} = create();
    await mixer.setScene({...fixtureScene(), layers: [fixtureLayer()]});
    expect(context.filters).toHaveLength(6);
    expect(context.filters.map(filter => filter.type)).toEqual(['lowshelf', 'peaking', 'highshelf', 'lowshelf', 'peaking', 'highshelf']);
    expect(context.filters.map(filter => filter.frequency.value)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(context.filters[1]!.Q.value).toBe(Math.SQRT1_2);
    expect(context.filters[4]!.Q.value).toBe(Math.SQRT1_2);
    expect(context.filters.every(filter => filter.gain.value === 0 && filter.detune.value === 0)).toBe(true);
    await mixer.play();
    const [masterGain, layerGain, envelope] = context.gains;
    const pan = [...layerGain!.targets][0] as FakeNode;
    const analyser = [...masterGain!.targets][0] as FakeNode;
    expect(context.sources[0]!.targets.has(envelope)).toBe(true);
    expect(envelope!.targets.has(context.filters[3])).toBe(true);
    expect(context.filters[3]!.targets.has(context.filters[4])).toBe(true);
    expect(context.filters[4]!.targets.has(context.filters[5])).toBe(true);
    expect(context.filters[5]!.targets.has(layerGain)).toBe(true);
    expect(pan.targets.has(context.filters[0])).toBe(true);
    expect(context.filters[0]!.targets.has(context.filters[1])).toBe(true);
    expect(context.filters[1]!.targets.has(context.filters[2])).toBe(true);
    expect(context.filters[2]!.targets.has(masterGain)).toBe(true);
    expect(analyser.targets.has(context.destination)).toBe(true);
  });

  it('ramps only the selected layer EQ over 20 ms without decoding, restarting sources, or moving the clock', async () => {
    const loaded: string[] = [];
    const {context, mixer, snapshot} = create(undefined, async id => { loaded.push(id); return fakeBuffer(2, 480_000); });
    await mixer.setScene(fixtureScene()); await mixer.play(); context.currentTime = 2;
    const sources = [...context.sources]; const filters = [...context.filters];
    const stops = sources.map(source => [...source.stops]);
    mixer.apply({type: 'setLayerEqualizer', layerId: 'narration', equalizer: shaped});
    expect(context.filters.slice(6).map(filter => filter.gain.ramps)).toEqual([[[6, 2.02]], [[-3, 2.02]], [[2, 2.02]]]);
    expect(context.filters.slice(6).map(filter => filter.frequency.valueAt(2))).toEqual([200, 1000, 4000]);
    expect(context.filters.slice(0, 6).every(filter => filter.gain.ramps.length === 0)).toBe(true);
    expect(context.filters.every((filter, index) => filter === filters[index])).toBe(true);
    expect(context.sources).toEqual(sources); expect(sources.map(source => source.stops)).toEqual(stops);
    expect(sources.every(source => source.starts.length === 1 && source.buffer !== null)).toBe(true);
    expect(loaded).toEqual(['asset-rain', 'asset-voice']);
    expect(snapshot()).toMatchObject({state: 'playing', positionSeconds: 2});
  });

  it('holds an in-progress ramp during bypass, restores the settings, and ignores unrelated control changes', async () => {
    const {context, mixer} = create();
    await mixer.setScene({...fixtureScene(), layers: [{...fixtureLayer(), equalizer: shaped}]}); await mixer.play();
    const bass = context.filters[3]!.gain;
    const settings = {bassDb: 12, midDb: -6, trebleDb: 4, bypassed: false};
    context.currentTime = 1;
    mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: settings});
    context.currentTime = 1.005;
    const beforeBypass = bass.valueAt(context.currentTime);
    mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: {...settings, bypassed: true}});
    expect(bass.valueAt(1.005)).toBeCloseTo(beforeBypass, 12);
    expect(bass.valueAt(1.005)).toBeCloseTo(7.5, 9);
    expect(bass.ramps.at(-1)).toEqual([0, 1.025]);
    expect(context.filters.slice(3).map(filter => filter.frequency.valueAt(1.024))).toEqual([200, 1000, 4000]);
    expect(context.filters.slice(3).map(filter => filter.frequency.valueAt(1.025))).toEqual([0, 0, 0]);
    context.currentTime = 1.03;
    mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: settings});
    expect(context.filters.slice(3).map(filter => filter.gain.value)).toEqual([12, -6, 4]);
    const events = context.filters.map(filter => structuredClone(filter.gain.events));
    context.currentTime = 1.035;
    mixer.apply({type: 'setMasterGain', gain: 0.3});
    expect(context.filters.map(filter => filter.gain.events)).toEqual(events);
    expect(context.sources).toHaveLength(1); expect(context.sources[0]!.starts).toHaveLength(1);
  });

  it('cancels a pending identity cutoff when bypass changes during the ramp without resetting sources', async () => {
    const {context, mixer} = create();
    await mixer.setScene({...fixtureScene(), masterEqualizer: {...shaped, bypassed: true},
      layers: [{...fixtureLayer(), equalizer: shaped}]}); await mixer.play();
    expect(context.filters.slice(0, 3).map(filter => filter.frequency.valueAt(0))).toEqual([0, 0, 0]);
    const source = context.sources[0]!;
    context.currentTime = 1;
    mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: {...shaped, bypassed: true}});
    context.currentTime = 1.005;
    const held = context.filters.slice(3).map(filter => filter.gain.valueAt(context.currentTime));
    mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: shaped});
    expect(context.filters.slice(3).map(filter => filter.gain.valueAt(1.005))).toEqual(held);
    expect(context.filters.slice(3).map(filter => filter.frequency.valueAt(1.03))).toEqual([200, 1000, 4000]);
    expect(context.filters.slice(3).every(filter => filter.frequency.events.every(event => event.time < 1.02 || event.value !== 0))).toBe(true);
    context.currentTime = 1.01;
    mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: flatEqualizer()});
    expect(context.filters.slice(3).map(filter => filter.frequency.valueAt(1.029))).toEqual([200, 1000, 4000]);
    expect(context.filters.slice(3).map(filter => filter.frequency.valueAt(1.03))).toEqual([0, 0, 0]);
    expect(context.filters.slice(3).map(filter => filter.gain.valueAt(1.03))).toEqual([0, 0, 0]);
    const before = context.filters.map(filter => structuredClone(filter.frequency.events));
    context.currentTime = 1.015;
    mixer.apply({type: 'setMasterGain', gain: 0.3});
    expect(context.filters.map(filter => filter.frequency.events)).toEqual(before);
    expect(context.sources).toEqual([source]); expect(source.starts).toHaveLength(1);
  });

  it('updates the master independently and keeps the same filters across live scene reconciliation', async () => {
    const {context, mixer, snapshot} = create();
    const base = {...fixtureScene(), layers: [{...fixtureLayer(), equalizer: shaped}]};
    await mixer.setScene(base); await mixer.play(); context.currentTime = 0.5;
    mixer.apply({type: 'setMasterEqualizer', equalizer: {...shaped, bassDb: -4}});
    expect(context.filters.slice(0, 3).map(filter => filter.gain.value)).toEqual([-4, -3, 2]);
    expect(context.filters.slice(3).map(filter => filter.gain.value)).toEqual([6, -3, 2]);
    const filters = [...context.filters]; const source = context.sources[0]!;
    context.currentTime = 0.75;
    await mixer.updateScene({...base, masterEqualizer: {...flatEqualizer(), midDb: 5},
      layers: [{...base.layers[0]!, equalizer: {...shaped, trebleDb: -8}}]});
    expect(context.filters.every((filter, index) => filter === filters[index])).toBe(true);
    expect(context.filters.slice(0, 3).map(filter => filter.gain.value)).toEqual([0, 5, 0]);
    expect(context.filters[5]!.gain.ramps.at(-1)).toEqual([-8, 0.77]);
    expect(context.sources).toEqual([source]); expect(source.starts).toHaveLength(1);
    expect(snapshot()).toMatchObject({state: 'playing', positionSeconds: 0.75});
  });

  it('retains the newest master and layer settings when an added asset finishes decoding', async () => {
    let resolve!: (buffer: AudioBuffer) => void;
    const late = new Promise<AudioBuffer>(done => { resolve = done; });
    const {context, mixer} = create(undefined, id => id === 'brush' ? late : Promise.resolve(fakeBuffer(2, 480_000)));
    const base = {...fixtureScene(), layers: [fixtureLayer()]};
    await mixer.setScene(base); await mixer.play(); context.currentTime = 1;
    const pending = mixer.updateScene({...base, layers: [...base.layers, {...fixtureLayer(), id: 'brush', assetId: 'brush'}]});
    mixer.apply({type: 'setLayerEqualizer', layerId: 'brush', equalizer: shaped});
    mixer.apply({type: 'setMasterEqualizer', equalizer: {...flatEqualizer(), trebleDb: -4}});
    resolve(fakeBuffer(2, 480_000)); await pending;
    expect(context.filters.slice(6).map(filter => filter.gain.value)).toEqual([6, -3, 2]);
    expect(context.filters.slice(0, 3).map(filter => filter.gain.value)).toEqual([0, 0, -4]);
    expect(context.sources).toHaveLength(2); expect(context.sources[0]!.starts).toHaveLength(1);
  });

  it('rejects malformed EQ updates before touching playing filter automation', async () => {
    const {context, mixer, snapshot} = create();
    await mixer.setScene(fixtureScene()); await mixer.play(); context.currentTime = 1;
    const before = context.filters.map(filter => structuredClone(filter.gain.events));
    expect(() => mixer.apply({type: 'setLayerEqualizer', layerId: 'ambience', equalizer: {...shaped, midDb: NaN}})).toThrow();
    expect(() => mixer.apply({type: 'setMasterEqualizer', equalizer: {...shaped, bassDb: 13}})).toThrow();
    expect(context.filters.map(filter => filter.gain.events)).toEqual(before);
    expect(context.sources).toHaveLength(2); expect(snapshot().state).toBe('playing');
  });

  it('leaves selected layer filters connected for natural tails and releases removed or disposed filter owners', async () => {
    const {context, mixer} = create();
    await mixer.setScene(fixtureScene()); await mixer.play();
    context.sources[0]!.onended?.();
    expect(context.filters.slice(3, 6).every(filter => !filter.disconnected)).toBe(true);
    context.currentTime = 0.5;
    mixer.apply({type: 'removeLayer', layerId: 'narration'});
    expect(context.filters.slice(6).every(filter => !filter.disconnected)).toBe(true);
    context.sources[1]!.onended?.();
    expect(context.filters.slice(6).every(filter => filter.disconnected)).toBe(true);
    mixer.dispose();
    expect(context.nodes.every(node => node.disconnected)).toBe(true);
    expect(context.sources.every(source => source.buffer === null)).toBe(true);
  });

  it('discards old master filter history on a scene switch and does not leak partially allocated chains', async () => {
    const {context, mixer} = create();
    await mixer.setScene({...fixtureScene(), masterEqualizer: shaped}); await mixer.play();
    const previous = [...context.filters];
    await mixer.setScene({...fixtureScene(), id: 'fresh'});
    expect(previous.every(filter => filter.disconnected)).toBe(true);
    expect(context.filters.slice(previous.length).every(filter => filter.gain.value === 0)).toBe(true);
    const failing = new FakeContext(); const original = failing.createBiquadFilter.bind(failing); let created = 0;
    failing.createBiquadFilter = () => { if (++created === 5) throw new Error('Cannot allocate another filter'); return original(); };
    const failed = create(failing);
    await expect(failed.mixer.setScene({...fixtureScene(), layers: [fixtureLayer()]})).rejects.toThrow('Cannot allocate another filter');
    expect(failing.filters.every(filter => filter.disconnected)).toBe(true);
    expect(failing.gains[1]!.disconnected).toBe(true);
    failed.mixer.dispose(); expect(failing.nodes.every(node => node.disconnected)).toBe(true);
  });

  it('keeps the accepted mix and EQ targets when an added graph fails, then retries with fresh nodes', async () => {
    const {context, mixer, snapshot} = create();
    const base = {...fixtureScene(), masterEqualizer: shaped, layers: [{...fixtureLayer(), equalizer: shaped}]};
    await mixer.setScene(base); await mixer.play(); context.currentTime = 0.5;
    const retainedFilters = [...context.filters]; const retainedSource = context.sources[0]!;
    const retainedStops = [...retainedSource.stops];
    const before = retainedFilters.map(filter => structuredClone(filter.gain.events));
    const original = context.createBiquadFilter.bind(context); let allocated = 0;
    context.createBiquadFilter = () => { if (++allocated === 5) throw new Error('Cannot allocate another filter'); return original(); };
    const target = {...base, masterEqualizer: {...shaped, bassDb: -8}, layers: [
      {...base.layers[0]!, equalizer: {...shaped, midDb: 7}},
      {...fixtureLayer(), id: 'brush', equalizer: shaped},
      {...fixtureLayer(), id: 'paper', equalizer: {...shaped, trebleDb: -5}},
    ]};
    await expect(mixer.updateScene(target)).rejects.toThrow('Cannot allocate another filter');
    expect(retainedFilters.map(filter => filter.gain.events)).toEqual(before);
    expect(retainedFilters.every(filter => !filter.disconnected)).toBe(true);
    expect(context.filters.slice(retainedFilters.length).every(filter => filter.disconnected)).toBe(true);
    expect(context.sources).toEqual([retainedSource]); expect(retainedSource.stops).toEqual(retainedStops);
    expect(snapshot()).toMatchObject({state: 'playing', positionSeconds: 0.5});
    expect(() => mixer.apply({type: 'setLayerEqualizer', layerId: 'brush', equalizer: shaped})).toThrow();
    context.createBiquadFilter = original;
    await mixer.updateScene(target);
    expect(context.filters.slice(-6).map(filter => filter.gain.value)).toEqual([6, -3, 2, 6, -3, -5]);
    expect(retainedFilters.slice(0, 3).map(filter => filter.gain.value)).toEqual([-8, -3, 2]);
    expect(retainedFilters.slice(3).map(filter => filter.gain.value)).toEqual([6, 7, 2]);
    expect(context.sources).toHaveLength(3); expect(context.sources[0]).toBe(retainedSource);
    expect(retainedSource.starts).toHaveLength(1); expect(retainedSource.stops).toEqual(retainedStops);
    mixer.dispose(); expect(context.nodes.every(node => node.disconnected)).toBe(true);
  });
});
