import {describe,expect,it} from 'vitest';
import {applyCommand} from './commands.js';
import {parseScene,SceneValidationError,type Scene} from './scene.js';
import {parseExportRecipe} from './exports.js';
import {defaultOccasional,layerAssetIds,playbackAssetIds} from './occasional.js';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';

const settings={enabled:true,minPauseSeconds:4,maxPauseSeconds:12,seed:7,alternateAssetIds:['alternate'],levelVariation:.1,panVariation:.2};
function scene():Scene {const value:Scene=fixtureScene();value.layers[0]={...value.layers[0]!,occasional:structuredClone(settings)};return value;}

describe('saved occasional playback',()=>{
  it('leaves legacy recipes unchanged and supplies conservative explicit defaults',()=>{
    const original=fixtureScene();expect(JSON.stringify(parseScene(original))).toBe(JSON.stringify(original));
    expect(Object.hasOwn(parseScene(original).layers[0]!,'occasional')).toBe(false);
    expect(defaultOccasional(123)).toEqual({enabled:false,minPauseSeconds:4,maxPauseSeconds:12,seed:123,alternateAssetIds:[],levelVariation:0,panVariation:0});
  });
  it('validates all settings and references even when disabled',()=>{
    const invalid=[null,{}, {...settings,extra:true},{...settings,seed:-1},{...settings,seed:2**32},{...settings,seed:1.5},
      {...settings,minPauseSeconds:0},{...settings,maxPauseSeconds:3601},{...settings,minPauseSeconds:13},
      {...settings,levelVariation:.26},{...settings,panVariation:-.01},{...settings,maxPauseSeconds:Infinity},
      {...settings,alternateAssetIds:[' ']},{...settings,alternateAssetIds:['alternate','alternate']},
      {...settings,alternateAssetIds:[scene().layers[0]!.assetId]},
      {...settings,alternateAssetIds:Array.from({length:8},(_,i)=>'alt-'+i)}];
    for(const value of invalid){
      for(const occasional of [value,value&&typeof value==='object'?{...value,enabled:false}:value])
        expect(()=>parseScene({...scene(),layers:[{...scene().layers[0],occasional}]})).toThrow(SceneValidationError);
    }
    expect(parseScene(scene()).layers[0]!.occasional).toEqual(settings);
    expect(parseScene({...scene(),layers:[{...scene().layers[0],occasional:{...settings,minPauseSeconds:.25,maxPauseSeconds:.25,seed:0xffffffff}}]})).toBeDefined();
  });
  it('applies detached settings only to the target and preserves its saved loop while off',()=>{
    const original=fixtureScene(),before=structuredClone(original),value=structuredClone(settings);
    const next=applyCommand(original,{type:'setLayerOccasional',layerId:original.layers[0]!.id,occasional:value});
    value.alternateAssetIds.push('later');
    expect(next.layers[0]!.occasional).toEqual(settings);expect(next.layers[0]!.loop).toEqual(original.layers[0]!.loop);
    expect(next.layers[1]).toEqual(original.layers[1]);expect(next.revision).toBe(original.revision);expect(original).toEqual(before);
    const off=applyCommand(next,{type:'setLayerOccasional',layerId:original.layers[0]!.id,occasional:{...settings,enabled:false}});
    expect(off.layers[0]!.occasional).toEqual({...settings,enabled:false});
    expect(()=>applyCommand(next,{type:'setLayerOccasional',layerId:original.layers[0]!.id,occasional:{...settings,alternateAssetIds:[original.layers[0]!.assetId]}})).toThrow(SceneValidationError);
  });
  it('distinguishes all saved references from active playback references',()=>{
    const layer=scene().layers[0]!;
    expect(layerAssetIds(layer)).toEqual([layer.assetId,'alternate']);expect(playbackAssetIds(layer)).toEqual([layer.assetId,'alternate']);
    const off={...layer,occasional:{...settings,enabled:false}};
    expect(layerAssetIds(off)).toEqual([layer.assetId,'alternate']);expect(playbackAssetIds(off)).toEqual([layer.assetId]);
    expect(layerAssetIds(fixtureScene().layers[0]!)).toEqual([layer.assetId]);
  });
  it('requires every possible alternate in an immutable export recipe, even while disabled',()=>{
    const recipe={schemaVersion:1,id:'12345678-1234-4234-9234-123456789abc',createdAt:'2026-11-18T00:00:00.000Z',durationSeconds:10,
      scene:scene(),assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]};
    expect(()=>parseExportRecipe(recipe)).toThrow(SceneValidationError);
    recipe.scene.layers[0]!.occasional!.enabled=false;
    expect(()=>parseExportRecipe(recipe)).toThrow(SceneValidationError);
    const complete={...recipe,assets:[...recipe.assets,{...fixtureAsset(),id:'alternate',displayName:'Alternate declaration'}]};
    expect(parseExportRecipe(complete)).toEqual(complete);
  });
});
