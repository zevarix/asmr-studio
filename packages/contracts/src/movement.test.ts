import {describe,expect,it} from 'vitest';
import {applyCommand} from './commands.js';
import {parseScene,SceneValidationError} from './scene.js';
import {parseExportRecipe} from './exports.js';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';

describe('optional stereo movement',()=>{
  it('keeps legacy layers and export recipes unchanged without injected movement',()=>{
    const scene=fixtureScene();
    expect(JSON.stringify(parseScene(scene))).toBe(JSON.stringify(scene));
    expect(parseScene(scene).layers.every(layer=>!Object.hasOwn(layer,'movement'))).toBe(true);
    const recipe={schemaVersion:1,id:'12345678-1234-4234-9234-123456789abc',
      createdAt:'2026-11-18T00:00:00.000Z',durationSeconds:10,scene,
      assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]};
    expect(parseExportRecipe(recipe)).toEqual(recipe);
  });

  it('round-trips bounded fractional movement in scenes and captured export recipes',()=>{
    for(const movement of [
      {enabled:true,width:0,cycleSeconds:2},
      {enabled:true,width:1,cycleSeconds:600},
      {enabled:false,width:.375,cycleSeconds:30.5},
    ]){
      const scene=fixtureScene();const original=structuredClone(scene);
      const withMovement={...scene,layers:scene.layers.map((layer,index)=>index===0?{...layer,movement}:layer)};
      expect(parseScene(withMovement)).toEqual(withMovement);
      const recipe={schemaVersion:1,id:'12345678-1234-4234-9234-123456789abc',
        createdAt:'2026-11-18T00:00:00.000Z',durationSeconds:10,scene:withMovement,
        assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]};
      expect(parseExportRecipe(recipe)).toEqual(recipe);
      expect(scene).toEqual(original);
    }
  });

  it('rejects incomplete, unknown, non-finite and out-of-range settings',()=>{
    const valid={enabled:true,width:.3,cycleSeconds:30};
    const invalid:unknown[]=[null,{}, {enabled:true,width:.3},{...valid,enabled:'true'},
      {...valid,phase:0},...[-.01,1.01,NaN,Infinity,-Infinity,'0.3',null].map(width=>({...valid,width})),
      ...[0,1.99,600.01,NaN,Infinity,-Infinity,'30',null].map(cycleSeconds=>({...valid,cycleSeconds}))];
    for(const movement of invalid){
      const scene=fixtureScene();
      expect(()=>parseScene({...scene,layers:[{...scene.layers[0],movement}]})).toThrow(SceneValidationError);
    }
  });

  it('edits only the selected layer, detaches values and retains them when switched off',()=>{
    const scene=fixtureScene();const original=structuredClone(scene);
    const movement={enabled:true,width:.65,cycleSeconds:45};
    const enabled=applyCommand(scene,{type:'setLayerMovement',layerId:'ambience',movement});
    movement.width=.1;
    expect(enabled.layers[0]).toEqual({...original.layers[0],movement:{enabled:true,width:.65,cycleSeconds:45}});
    const disabled=applyCommand(enabled,{type:'setLayerMovement',layerId:'ambience',movement:{enabled:false,width:.65,cycleSeconds:45}});
    expect(disabled.layers[0]).toEqual({...original.layers[0],movement:{enabled:false,width:.65,cycleSeconds:45}});
    expect(disabled.layers[1]).toEqual(original.layers[1]);
    expect(disabled.revision).toBe(original.revision);
    expect(scene).toEqual(original);
  });

  it('rejects malformed commands and unknown layers before changing a recipe',()=>{
    const scene=fixtureScene();const original=structuredClone(scene);
    const movement={enabled:true,width:.3,cycleSeconds:30};
    for(const command of [
      {type:'setLayerMovement',layerId:'missing',movement},
      {type:'setLayerMovement',layerId:'ambience',movement:{...movement,width:2}},
      {type:'setLayerMovement',layerId:'ambience',movement,path:'/elsewhere'},
    ])expect(()=>applyCommand(scene,command as never)).toThrow(SceneValidationError);
    expect(scene).toEqual(original);
  });
});
