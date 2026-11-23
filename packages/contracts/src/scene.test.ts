import { describe, expect, it } from 'vitest';
import { createEmptyScene, parseScene, parseAssetRecord, SceneValidationError } from './scene.js';
import { applyCommand } from './commands.js';
import { fixtureScene, fixtureLayer, fixtureAsset } from '../../../tests/fixtures/scene.js';

describe('validated scene contract', () => {
  it('rejects_future_version_without_mutation', () => {
    const input = { ...fixtureScene(), schemaVersion: 2 };
    const before = structuredClone(input);
    expect(() => parseScene(input)).toThrow(SceneValidationError);
    expect(input).toEqual(before);
  });
  it('creates a silent unsaved scene with intentional defaults', () => {
    expect(createEmptyScene('scene-1', 'Quiet room')).toEqual({schemaVersion:1,id:'scene-1',title:'Quiet room',revision:0,masterGain:0.25,durationSeconds:null,layers:[]});
  });
  it('rejects_duplicate_ids_and_nonfinite_numbers', () => {
    expect(() => parseScene({...fixtureScene(),layers:[fixtureLayer(),fixtureLayer()]})).toThrow(SceneValidationError);
    for (const gain of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => parseScene({...fixtureScene(),masterGain:gain})).toThrow(SceneValidationError);
      expect(() => parseScene({...fixtureScene(),layers:[{...fixtureLayer(),gain}]})).toThrow(SceneValidationError);
    }
    for (const pan of [-1.01,1.01,NaN,Infinity]) {
      expect(() => parseScene({...fixtureScene(),layers:[{...fixtureLayer(),pan}]})).toThrow(SceneValidationError);
    }
  });
  it('validates_loop_interval', () => {
    for (const loop of [
      {startSeconds:0,endSeconds:0,crossfadeSeconds:0},
      {startSeconds:2,endSeconds:1,crossfadeSeconds:0},
      {startSeconds:-1,endSeconds:1,crossfadeSeconds:0},
      {startSeconds:0,endSeconds:2,crossfadeSeconds:1.01},
      {startSeconds:0,endSeconds:2,crossfadeSeconds:NaN},
    ]) expect(() => parseScene({...fixtureScene(),layers:[{...fixtureLayer(),loop}]})).toThrow(SceneValidationError);
    expect(parseScene({...fixtureScene(),layers:[{...fixtureLayer(),loop:{startSeconds:1,endSeconds:3,crossfadeSeconds:1}}]}).layers[0]?.loop).toEqual({startSeconds:1,endSeconds:3,crossfadeSeconds:1});
  });
  it('rejects empty identities, unsafe revisions and nonpositive timed durations', () => {
    for (const id of ['', ' ']) expect(() => parseScene({...fixtureScene(),id})).toThrow(SceneValidationError);
    for (const title of ['', ' ']) expect(() => parseScene({...fixtureScene(),title})).toThrow(SceneValidationError);
    for (const revision of [-1,0.5,Number.MAX_SAFE_INTEGER+1,Infinity]) expect(() => parseScene({...fixtureScene(),revision})).toThrow(SceneValidationError);
    for (const durationSeconds of [0,-1,NaN,Infinity]) expect(() => parseScene({...fixtureScene(),durationSeconds})).toThrow(SceneValidationError);
    expect(parseScene({...fixtureScene(),durationSeconds:300}).durationSeconds).toBe(300);
  });
  it('rejects unrecognized fields and defaults imported narration to no loop', () => {
    expect(() => parseScene({...fixtureScene(),voiceReference:'/private/ref.wav'})).toThrow(SceneValidationError);
    const {loop:_,...narration}=fixtureLayer({id:'voice',role:'narration'});
    expect(parseScene({...fixtureScene(),layers:[narration]}).layers[0]?.loop).toBeNull();
    expect(() => parseScene({...fixtureScene(),layers:[{...fixtureLayer(),path:'../../etc/passwd'}]})).toThrow(SceneValidationError);
  });
  it('keeps asset rights and measured metadata explicit', () => {
    expect(parseAssetRecord(fixtureAsset()).rights).toEqual({privateUse:'permitted',redistribution:'unknown'});
    for (const change of [{sha256:'bad'},{channels:0},{sampleRate:0},{durationSeconds:Infinity},{format:''}]) {
      expect(() => parseAssetRecord({...fixtureAsset(),...change})).toThrow(SceneValidationError);
    }
  });
});

describe('immutable scene commands', () => {
  it('edits_only_selected_layer', () => {
    const input=fixtureScene(); const before=structuredClone(input);
    const next=applyCommand(input,{type:'setLayerGain',layerId:'narration',gain:0.7});
    expect(next.layers[1]?.gain).toBe(0.7);
    expect(next.layers[0]).toEqual(before.layers[0]);
    expect(next.revision).toBe(1); expect(input).toEqual(before);
    expect(next).not.toBe(input);
  });
  it('adds and removes only the requested layer', () => {
    const base=fixtureScene(); const extra=fixtureLayer({id:'texture',role:'texture',assetId:'asset-brush'});
    const added=applyCommand(base,{type:'addLayer',layer:extra});
    extra.gain=0.1;
    expect(added.layers.map(x=>x.id)).toEqual(['ambience','narration','texture']);
    expect(added.layers[2]?.gain).toBe(0.5);
    expect(applyCommand(added,{type:'removeLayer',layerId:'texture'})).toEqual(base);
  });
  it('changes pan mute solo and master independently', () => {
    const base=fixtureScene();
    expect(applyCommand(base,{type:'setLayerPan',layerId:'narration',pan:-1}).layers[1]?.pan).toBe(-1);
    expect(applyCommand(base,{type:'setMuted',layerId:'narration',muted:true}).layers[1]).toEqual({...base.layers[1],muted:true});
    expect(applyCommand(base,{type:'setSolo',layerId:'narration',solo:true}).layers[1]).toEqual({...base.layers[1],solo:true});
    expect(applyCommand(base,{type:'setMasterGain',gain:0}).masterGain).toBe(0);
    expect(applyCommand(base,{type:'setMasterGain',gain:1}).layers).toEqual(base.layers);
  });
  it('edits loop settings immutably and validates the requested interval', () => {
    const base=fixtureScene();
    const loop={startSeconds:0.2,endSeconds:1.8,crossfadeSeconds:0.15};
    const next=applyCommand(base,{type:'setLayerLoop',layerId:'ambience',loop});
    loop.endSeconds=0.1;
    expect(next.layers[0]?.loop).toEqual({startSeconds:0.2,endSeconds:1.8,crossfadeSeconds:0.15});
    expect(next.layers[1]).toEqual(base.layers[1]);
    expect(base.layers[0]?.loop).toBeNull();
    expect(applyCommand(next,{type:'setLayerLoop',layerId:'ambience',loop:null})).toEqual(base);
    expect(()=>applyCommand(base,{type:'setLayerLoop',layerId:'ambience',loop})).toThrow(SceneValidationError);
    expect(()=>applyCommand(base,{type:'setLayerLoop',layerId:'missing',loop:null})).toThrow(SceneValidationError);
  });
  it('invalid commands throw typed errors without changing the scene', () => {
    const base=fixtureScene(); const before=structuredClone(base);
    for (const command of [
      {type:'removeLayer',layerId:'missing'},
      {type:'setLayerGain',layerId:'missing',gain:0.1},
      {type:'setLayerGain',layerId:'narration',gain:NaN},
      {type:'setMasterGain',gain:2},
      {type:'setLayerPan',layerId:'narration',pan:2},
      {type:'setMuted',layerId:'narration',muted:'yes'},
      {type:'addLayer',layer:fixtureLayer()},
      {type:'unknown'},
      {type:'setMasterGain',gain:0.2,unrecognized:true},
    ]) expect(() => applyCommand(base,command as never)).toThrow(SceneValidationError);
    expect(base).toEqual(before);
  });
});
