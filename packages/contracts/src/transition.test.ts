import {describe,expect,it} from 'vitest';
import {applyCommand} from './commands.js';
import {createEmptyTransition,parseCapturedMix,parseScene,SceneValidationError,type CapturedMix,type MixTransition,type Scene} from './scene.js';
import {parseExportRecipe} from './exports.js';
import {sceneAssetIds,sceneLayerCount,scenePlaybackAssetIds,transitionBlendAt,transitionGainsAt} from './transition.js';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';

function capture(id='capture-a'):CapturedMix {
  return parseCapturedMix({id,scene:fixtureScene(),assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]});
}
function arrangement():Scene {
  const scene=createEmptyTransition('arrangement','A to B');
  scene.transition!.a=capture();scene.transition!.b=capture('capture-b');
  return parseScene(scene);
}

describe('saved mix transition contracts',()=>{
  it('keeps ordinary documents byte-identical and creates an independent conservative arrangement',()=>{
    const ordinary=fixtureScene();expect(JSON.stringify(parseScene(ordinary))).toBe(JSON.stringify(ordinary));
    expect(Object.hasOwn(parseScene(ordinary),'transition')).toBe(false);
    expect(createEmptyTransition('new','Transition')).toEqual({schemaVersion:1,id:'new',title:'Transition',revision:0,
      masterGain:1,outputLimiter:{enabled:true,ceilingDb:-1},durationSeconds:null,layers:[],
      transition:{a:null,b:null,curve:'linear',mode:'manual',blend:0,durationSeconds:30,startSeconds:0,startPositions:{a:0,b:0}}});
  });
  it('detaches captures and preserves every source setting and declaration',()=>{
    const source=capture();source.scene.layers[0]!.loop={startSeconds:0,endSeconds:2,crossfadeSeconds:.1};
    source.scene.outputLimiter={enabled:true,ceilingDb:-6};
    source.scene.listeningTimer={enabled:true,durationSeconds:10,fadeInSeconds:1,fadeOutSeconds:2};
    const parsed=parseCapturedMix(source);source.assets[0]!.displayName='Later edit';source.scene.layers[0]!.gain=0;
    expect(parsed.assets[0]!.displayName).toBe('Rain fixture');expect(parsed.scene.layers[0]!.gain).toBe(.5);
    expect(parsed.scene.layers[0]!.loop).toEqual({startSeconds:0,endSeconds:2,crossfadeSeconds:.1});
    expect(parsed.scene.outputLimiter).toEqual({enabled:true,ceilingDb:-6});
    expect(parsed.scene.listeningTimer?.durationSeconds).toBe(10);
  });
  it('rejects nested or unsaved captures and inaccurate asset coverage',()=>{
    const source=capture();
    for(const invalid of [
      {...source,scene:{...source.scene,revision:0}},
      {...source,scene:{...source.scene,transition:arrangement().transition}},
      {...source,assets:source.assets.slice(0,1)},
      {...source,assets:[...source.assets,source.assets[0]]},
      {...source,assets:[...source.assets,{...fixtureAsset(),id:'extra'}]},
      {...source,scene:{...source.scene,layers:[{...source.scene.layers[0],loop:{startSeconds:0,endSeconds:3,crossfadeSeconds:0}}]}}
    ])expect(()=>parseCapturedMix(invalid)).toThrow(SceneValidationError);
  });
  it('requires inactive alternatives in captures while decoding only the active set',()=>{
    const source=capture();source.scene.layers[0]!.occasional={enabled:false,minPauseSeconds:1,maxPauseSeconds:2,seed:9,
      alternateAssetIds:['alternate'],levelVariation:0,panVariation:0};
    expect(()=>parseCapturedMix(source)).toThrow(SceneValidationError);
    source.assets.push({...fixtureAsset(),id:'alternate'});
    const scene=arrangement();scene.transition!.a=parseCapturedMix(source);
    expect(sceneAssetIds(scene)).toEqual(['asset-rain','alternate','asset-voice']);
    expect(scenePlaybackAssetIds(scene)).toEqual(['asset-rain','asset-voice']);
    expect(sceneLayerCount(scene)).toBe(4);
  });
  it('rejects ambiguous wrapper processing and source identity reuse',()=>{
    const scene=arrangement();
    for(const invalid of [
      {...scene,layers:fixtureScene().layers},
      {...scene,id:fixtureScene().id},
      {...scene,durationSeconds:30},
      {...scene,masterEqualizer:{bassDb:0,midDb:0,trebleDb:0,bypassed:false}},
      {...scene,listeningTimer:{enabled:false,durationSeconds:30,fadeInSeconds:0,fadeOutSeconds:0}}
    ])expect(()=>parseScene(invalid)).toThrow(SceneValidationError);
  });
  it('validates the complete finite timing and linear-only recipe',()=>{
    const scene=arrangement(),settings=scene.transition!;
    const invalid=[{blend:-.01},{blend:1.01},{blend:NaN},{curve:'equal-power'},{mode:'playlist'},{durationSeconds:0},
      {durationSeconds:3600.01},{durationSeconds:Infinity},{startSeconds:-1},{startSeconds:NaN},
      {startPositions:{a:0,b:1}},{startPositions:{a:0,b:0,extra:true}},{extra:true}];
    for(const changes of invalid)expect(()=>parseScene({...scene,transition:{...settings,...changes}})).toThrow(SceneValidationError);
    expect(parseScene({...scene,transition:{...settings,durationSeconds:.1,startSeconds:900}}).transition?.durationSeconds).toBe(.1);
  });
  it('permits common recordings but rejects conflicting captured records',()=>{
    const scene=arrangement();expect(parseScene(scene).transition?.b?.assets).toEqual(scene.transition!.a!.assets);
    scene.transition!.b!.assets[0]!.rights.redistribution='permitted';
    expect(()=>parseScene(scene)).toThrow(SceneValidationError);
    scene.transition!.b!.assets[0]!.id='same-content-separate-credit';
    scene.transition!.b!.scene.layers[0]!.assetId='same-content-separate-credit';
    const parsed=parseScene(scene);expect(sceneAssetIds(parsed)).toHaveLength(3);expect(sceneLayerCount(parsed)).toBe(4);
  });
  it('edits arrangements immutably without converting or overwriting a source mix',()=>{
    const scene=arrangement(),before=structuredClone(scene),transition={...structuredClone(scene.transition!),mode:'timed' as const,startSeconds:8};
    const changed=applyCommand(scene,{type:'setTransition',transition});
    transition.a!.scene.title='Caller mutation';
    expect(changed.transition!.a!.scene.title).toBe('Quiet room');expect(scene).toEqual(before);
    expect(changed.revision).toBe(before.revision);expect(changed.transition!.startSeconds).toBe(8);
    expect(()=>applyCommand(fixtureScene(),{type:'setTransition',transition:before.transition!})).toThrow(SceneValidationError);
    expect(()=>applyCommand(before,{type:'setListeningTimer',timer:{enabled:false,durationSeconds:30,fadeInSeconds:0,fadeOutSeconds:0}})).toThrow(SceneValidationError);
  });
  it('requires both captures and exact declarations at the export boundary',()=>{
    const scene=arrangement();
    const recipe={schemaVersion:1,id:'12345678-1234-4234-9234-123456789abc',createdAt:'2026-11-18T00:00:00.000Z',durationSeconds:1,
      scene,assets:scene.transition!.a!.assets};
    expect(parseExportRecipe(recipe)).toEqual(recipe);
    expect(()=>parseExportRecipe({...recipe,assets:[{...fixtureAsset(),displayName:'Forged credit'},recipe.assets[1]]})).toThrow(SceneValidationError);
    expect(()=>parseExportRecipe({...recipe,scene:{...scene,transition:{...scene.transition,b:null}}})).toThrow(SceneValidationError);
    scene.transition!.a!.scene.listeningTimer={enabled:true,durationSeconds:10,fadeInSeconds:3,fadeOutSeconds:3};
    // An arrangement export crops a captured timer; it does not remap its endpoint.
    expect(parseExportRecipe(recipe).durationSeconds).toBe(1);
  });
});

describe('linear transition recipe',()=>{
  const settings:MixTransition={...arrangement().transition!,mode:'timed',blend:.2,startSeconds:5,durationSeconds:10};
  it('holds the initial blend, reaches both exact endpoints, and stays at B',()=>{
    expect([-1,0,5,15,20].map(at=>transitionBlendAt(settings,at))).toEqual([.2,.2,.2,1,1]);
    expect(transitionBlendAt(settings,10)).toBeCloseTo(.6,14);
    expect(transitionBlendAt({...settings,mode:'manual',blend:.35},1000)).toBe(.35);
  });
  it('keeps aligned correlated content at unity and uncorrelated gains explicit',()=>{
    for(const at of [0,5,7.123,10,14.99,15,900]){
      const gains=transitionGainsAt(settings,at);expect(gains[0]+gains[1]).toBe(1);
      expect(gains[0]*.8+gains[1]*.8).toBeCloseTo(.8,14);
    }
    expect(transitionGainsAt({...settings,mode:'manual',blend:.5},0)).toEqual([.5,.5]);
  });
  it('routes a single prepared side at full blend gain without losing A during B preparation',()=>{
    expect(transitionGainsAt({...settings,b:null},15)).toEqual([1,0]);
    expect(transitionGainsAt({...settings,a:null},0)).toEqual([0,1]);
    expect(transitionGainsAt({...settings,a:null,b:null},0)).toEqual([0,0]);
  });
});
