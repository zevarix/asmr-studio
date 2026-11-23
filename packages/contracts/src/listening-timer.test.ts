import {describe,expect,it} from 'vitest';
import {applyCommand} from './commands.js';
import {parseScene,SceneValidationError} from './scene.js';
import {parseExportRecipe,EXPORT_SAMPLE_RATE} from './exports.js';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';

const timer={enabled:true,durationSeconds:8,fadeInSeconds:2,fadeOutSeconds:4};
const recipe=(durationSeconds:number,listeningTimer=timer)=>({schemaVersion:1,id:'12345678-1234-4234-9234-123456789abc',
  createdAt:'2026-11-18T00:00:00.000Z',durationSeconds,scene:{...fixtureScene(),listeningTimer},
  assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]});

describe('saved listening timer',()=>{
  it('keeps old recipes byte-for-byte equal when timer settings are absent',()=>{
    for(const durationSeconds of [null,30]){
      const scene={...fixtureScene(),durationSeconds};
      expect(JSON.stringify(parseScene(scene))).toBe(JSON.stringify(scene));
      expect(Object.hasOwn(parseScene(scene),'listeningTimer')).toBe(false);
    }
  });
  it('accepts finite fractional timers, retained Off settings, and touching fade endpoints',()=>{
    for(const value of [timer,{...timer,enabled:false},{...timer,durationSeconds:6},
      {enabled:true,durationSeconds:.5,fadeInSeconds:.125,fadeOutSeconds:.375},
      {...timer,durationSeconds:10_000_000}]){
      expect(parseScene({...fixtureScene(),listeningTimer:value}).listeningTimer).toEqual(value);
    }
  });
  it('rejects invalid, incomplete, unknown, and overlapping settings even while Off',()=>{
    const bad:unknown[]=[null,{}, {...timer,extra:1},{...timer,enabled:'true'},
      ...[0,-1,NaN,Infinity,'8'].map(durationSeconds=>({...timer,durationSeconds})),
      ...[-1,NaN,Infinity,'2'].map(fadeInSeconds=>({...timer,fadeInSeconds})),
      ...[-1,NaN,Infinity,'4'].map(fadeOutSeconds=>({...timer,fadeOutSeconds})),
      {...timer,durationSeconds:5},{...timer,durationSeconds:5,enabled:false}];
    for(const listeningTimer of bad)expect(()=>parseScene({...fixtureScene(),listeningTimer})).toThrow(SceneValidationError);
  });
  it('applies complete detached settings, clears the legacy deadline and retains values while Off',()=>{
    const scene={...fixtureScene(),durationSeconds:60},original=structuredClone(scene),value={...timer};
    const next=applyCommand(scene,{type:'setListeningTimer',timer:value});value.durationSeconds=90;
    expect(next.listeningTimer).toEqual(timer);expect(next.durationSeconds).toBeNull();
    expect(next.layers).toEqual(scene.layers);expect(next.revision).toBe(scene.revision);expect(scene).toEqual(original);
    const off=applyCommand(next,{type:'setListeningTimer',timer:{...timer,enabled:false}});
    expect(off.listeningTimer).toEqual({...timer,enabled:false});expect(off.durationSeconds).toBeNull();
    expect(()=>applyCommand(next,{type:'setListeningTimer',timer:{...timer,fadeInSeconds:9}})).toThrow(SceneValidationError);
    expect(next.listeningTimer).toEqual(timer);
  });
  it('validates enabled export fades against the actual render endpoint, preserving the saved timer',()=>{
    expect(parseExportRecipe(recipe(6))).toEqual(recipe(6));
    expect(parseExportRecipe(recipe(10)).scene.listeningTimer?.durationSeconds).toBe(8);
    expect(()=>parseExportRecipe(recipe(5))).toThrow(SceneValidationError);
    expect(parseExportRecipe(recipe(.125,{...timer,enabled:false})).durationSeconds).toBe(.125);
    const fractional={...timer,fadeInSeconds:0,fadeOutSeconds:1/EXPORT_SAMPLE_RATE+.000001};
    expect(()=>parseExportRecipe(recipe(fractional.fadeOutSeconds,fractional))).toThrow(SceneValidationError);
    expect(parseExportRecipe(recipe(2/EXPORT_SAMPLE_RATE,fractional)).scene.listeningTimer).toEqual(fractional);
  });
});
