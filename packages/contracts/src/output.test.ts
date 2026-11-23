import {describe,expect,it} from 'vitest';
import {applyCommand} from './commands.js';
import {createEmptyScene,parseScene,SceneValidationError} from './scene.js';
import {parseExportRecipe} from './exports.js';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';

describe('optional output limiter',()=>{
  it('preserves legacy scenes without adding settings during parsing',()=>{
    const legacy=fixtureScene();
    expect(JSON.stringify(parseScene(legacy))).toBe(JSON.stringify(legacy));
    expect(createEmptyScene('new','Quiet room')).not.toHaveProperty('outputLimiter');
  });

  it('round-trips bounded settings through scenes and immutable export recipes',()=>{
    for(const ceilingDb of [-12,-6.25,-1,-0.1]){
      const scene={...fixtureScene(),outputLimiter:{enabled:true,ceilingDb}};
      expect(parseScene(scene)).toEqual(scene);
      const recipe={schemaVersion:1,id:'12345678-1234-4234-9234-123456789abc',
        createdAt:'2026-11-18T00:00:00.000Z',durationSeconds:10,scene,
        assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]};
      expect(parseExportRecipe(recipe)).toEqual(recipe);
    }
  });

  it('rejects invalid ceilings, incomplete settings, and unknown fields',()=>{
    for(const ceilingDb of [-12.01,0,-0.09,NaN,Infinity,-Infinity,'-1',null]){
      expect(()=>parseScene({...fixtureScene(),outputLimiter:{enabled:true,ceilingDb}})).toThrow(SceneValidationError);
    }
    for(const outputLimiter of [null,{}, {enabled:false}, {ceilingDb:-1},
      {enabled:'false',ceilingDb:-1},{enabled:true,ceilingDb:-1,normalize:true}]){
      expect(()=>parseScene({...fixtureScene(),outputLimiter})).toThrow(SceneValidationError);
    }
  });

  it('detaches a limiter edit and retains its ceiling when disabled',()=>{
    const base=fixtureScene();const original=structuredClone(base);
    const limiter={enabled:true,ceilingDb:-3};
    const enabled=applyCommand(base,{type:'setOutputLimiter',limiter});
    limiter.ceilingDb=-9;
    expect(enabled).toEqual({...original,outputLimiter:{enabled:true,ceilingDb:-3}});
    const disabled=applyCommand(enabled,{type:'setOutputLimiter',limiter:{enabled:false,ceilingDb:-3}});
    expect(disabled).toEqual({...original,outputLimiter:{enabled:false,ceilingDb:-3}});
    expect(base).toEqual(original);
  });

  it('rejects a malformed command without changing the current recipe',()=>{
    const base=fixtureScene();const original=structuredClone(base);
    for(const command of [
      {type:'setOutputLimiter',limiter:{enabled:true,ceilingDb:1}},
      {type:'setOutputLimiter',limiter:{enabled:true,ceilingDb:-1},path:'other'},
    ])expect(()=>applyCommand(base,command as never)).toThrow(SceneValidationError);
    expect(base).toEqual(original);
  });
});
