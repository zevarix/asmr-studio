import {describe, expect, it} from 'vitest';
import {applyCommand} from './commands.js';
import {EQ_MAX_DB, EQ_MIN_DB, equalizerSchema, flatEqualizer} from './equalizer.js';
import {parseExportRecipe} from './exports.js';
import {createEmptyScene, parseScene, SceneValidationError} from './scene.js';
import {fixtureAsset, fixtureScene} from '../../../tests/fixtures/scene.js';

describe('optional equalizer contracts', () => {
  it('keeps legacy scenes and immutable export recipes free of new default fields', () => {
    const legacy = fixtureScene();
    const parsed = parseScene(legacy);
    expect(parsed).toEqual(legacy); expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
    expect(parsed).not.toHaveProperty('masterEqualizer');
    expect(parsed.layers.every(layer => !Object.hasOwn(layer, 'equalizer'))).toBe(true);
    expect(createEmptyScene('new', 'Quiet room')).not.toHaveProperty('masterEqualizer');
    const recipe = {schemaVersion: 1, id: '12345678-1234-4234-9234-123456789abc',
      createdAt: '2026-11-18T00:00:00.000Z', durationSeconds: 10, scene: legacy,
      assets: [fixtureAsset(), {...fixtureAsset(), id: 'asset-voice'}]};
    expect(parseExportRecipe(recipe)).toEqual(recipe);
  });

  it('accepts bounded fractional settings and returns an independent flat reset each time', () => {
    expect(equalizerSchema.parse({bassDb: EQ_MIN_DB, midDb: 1.25, trebleDb: EQ_MAX_DB, bypassed: true}))
      .toEqual({bassDb: -12, midDb: 1.25, trebleDb: 12, bypassed: true});
    const first = flatEqualizer(); const second = flatEqualizer();
    first.bassDb = 5; first.bypassed = true;
    expect(second).toEqual({bassDb: 0, midDb: 0, trebleDb: 0, bypassed: false});
    expect(first).not.toBe(second);
  });

  it('rejects invalid settings at the scene and layer boundaries without repairing input', () => {
    for (const key of ['bassDb', 'midDb', 'trebleDb'] as const) {
      for (const value of [-12.01, 12.01, NaN, Infinity, -Infinity, '3', null]) {
        const settings = {...flatEqualizer(), [key]: value};
        expect(() => parseScene({...fixtureScene(), masterEqualizer: settings})).toThrow(SceneValidationError);
        expect(() => parseScene({...fixtureScene(), layers: [{...fixtureScene().layers[0], equalizer: settings}]})).toThrow(SceneValidationError);
      }
    }
    for (const settings of [null, {}, {bassDb: 0, midDb: 0, trebleDb: 0},
      {...flatEqualizer(), bypassed: 'false'}, {...flatEqualizer(), frequency: 200}]) {
      expect(() => parseScene({...fixtureScene(), masterEqualizer: settings})).toThrow(SceneValidationError);
    }
  });

  it('applies detached master and selected-layer settings without changing other controls or revisions', () => {
    const base = fixtureScene(); const original = structuredClone(base);
    const settings = {bassDb: 6, midDb: -2, trebleDb: 1.5, bypassed: false};
    const master = applyCommand(base, {type: 'setMasterEqualizer', equalizer: settings});
    const layer = applyCommand(master, {type: 'setLayerEqualizer', layerId: 'narration', equalizer: settings});
    settings.bassDb = -12;
    expect(layer.layers[1]?.equalizer).toEqual({bassDb: 6, midDb: -2, trebleDb: 1.5, bypassed: false});
    expect(layer.masterEqualizer).toEqual(layer.layers[1]?.equalizer);
    expect(layer.masterEqualizer).not.toBe(layer.layers[1]?.equalizer);
    expect(layer.layers[0]).toEqual(base.layers[0]);
    expect(layer.masterGain).toBe(base.masterGain); expect(layer.revision).toBe(base.revision);
    expect(base).toEqual(original); expect(master.layers).toEqual(base.layers);
  });

  it('retains knob values during bypass and makes an explicit reset neutral', () => {
    const settings = {bassDb: -4, midDb: 7, trebleDb: 3, bypassed: false};
    const base = applyCommand(fixtureScene(), {type: 'setLayerEqualizer', layerId: 'ambience', equalizer: settings});
    const bypassed = applyCommand(base, {type: 'setLayerEqualizer', layerId: 'ambience', equalizer: {...settings, bypassed: true}});
    expect(bypassed.layers[0]?.equalizer).toEqual({...settings, bypassed: true});
    expect(base.layers[0]?.equalizer?.bypassed).toBe(false);
    const reset = applyCommand(bypassed, {type: 'setLayerEqualizer', layerId: 'ambience', equalizer: flatEqualizer()});
    expect(reset.layers[0]?.equalizer).toEqual(flatEqualizer());
  });

  it('rejects malformed commands and nonexistent layers before mutating a valid scene', () => {
    const base = fixtureScene(); const original = structuredClone(base);
    for (const command of [
      {type: 'setLayerEqualizer', layerId: 'missing', equalizer: flatEqualizer()},
      {type: 'setLayerEqualizer', layerId: 'ambience', equalizer: {...flatEqualizer(), bassDb: 13}},
      {type: 'setMasterEqualizer', equalizer: {...flatEqualizer(), bypassed: null}},
      {type: 'setMasterEqualizer', equalizer: flatEqualizer(), path: '/private/filter'},
    ]) expect(() => applyCommand(base, command as never)).toThrow(SceneValidationError);
    expect(base).toEqual(original);
  });
});
