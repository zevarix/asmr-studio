import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,renderHook,waitFor} from '@testing-library/react';
import {defaultOccasional,flatEqualizer,parseCapturedMix,parseScene,type Scene} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {studioApi,StudioApiError} from '../../api.js';
import {useSession} from './useSession.js';

function deferred<T>() {
  let resolve!:(value:T)=>void;
  let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const empty=(id:string,title:string)=>parseScene({schemaVersion:1,id,title,revision:1,masterGain:.25,durationSeconds:null,layers:[]});

beforeEach(()=>{
  localStorage.clear();
  window.history.replaceState(null,'','/');
  vi.spyOn(studioApi,'listAssets').mockResolvedValue([fixtureAsset()]);
  vi.spyOn(studioApi,'listStarterSounds').mockResolvedValue([]);
  vi.spyOn(studioApi,'listScenes').mockResolvedValue([]);
  vi.spyOn(studioApi,'getScene').mockRejectedValue(new StudioApiError('NOT_FOUND',404,'Missing'));
});

describe('starter loop defaults',()=>{
  const asset={...fixtureAsset(),durationSeconds:20};
  const prepared={startSeconds:0,endSeconds:20,crossfadeSeconds:0};
  const catalog=[{id:'prepared-rain',assetId:asset.id,preferredLoop:prepared}];

  it('uses the installed sound defaults for a new layer and keeps narration non-looping',async()=>{
    vi.mocked(studioApi.listAssets).mockResolvedValue([asset]);
    vi.mocked(studioApi.listStarterSounds).mockResolvedValue(catalog);
    const {result}=await ready();
    act(()=>result.current.addAsset(asset,'ambience'));
    expect(result.current.scene.layers[0]?.loop).toEqual(prepared);
    act(()=>result.current.addAsset(asset,'narration'));
    expect(result.current.scene.layers[1]?.loop).toBeNull();
  });

  it('loads existing media when the optional catalog fails and uses ordinary import defaults',async()=>{
    vi.mocked(studioApi.listAssets).mockResolvedValue([asset]);
    vi.mocked(studioApi.listStarterSounds).mockRejectedValue(new Error('Catalog unavailable'));
    const {result}=await ready();
    expect(result.current.assets).toEqual([asset]);
    act(()=>result.current.addAsset(asset,'ambience'));
    expect(result.current.scene.layers[0]?.loop).toEqual({startSeconds:0,endSeconds:19.975,crossfadeSeconds:.02});
  });

  it('refreshes defaults before installation resolves without changing an edited layer',async()=>{
    vi.mocked(studioApi.listAssets).mockResolvedValue([asset]);
    const {result}=await ready();
    act(()=>result.current.addAsset(asset,'ambience'));
    const first=result.current.scene.layers[0]!;
    const edited={startSeconds:2,endSeconds:12,crossfadeSeconds:.25};
    act(()=>result.current.edit({type:'setLayerLoop',layerId:first.id,loop:edited}));
    const original=result.current.scene;
    const version=result.current.getStateVersion();
    vi.spyOn(studioApi,'installStarterSounds').mockResolvedValue([asset]);
    vi.mocked(studioApi.listStarterSounds).mockResolvedValue(catalog);
    await act(async()=>{
      await result.current.installStarterSounds();
      expect(result.current.getScene()).toEqual(original);
      expect(result.current.getStateVersion()).toBe(version);
      // The ref is ready even before React commits the catalog's state update.
      result.current.addAsset(asset,'ambience');
    });
    expect(result.current.scene.layers.map(layer=>layer.loop)).toEqual([edited,prepared]);
    expect(result.current.preferredLoops.get(asset.id)).toEqual(prepared);
  });

  it('exposes installed sounds only after their defaults arrive and retains a concurrent import',async()=>{
    const {result}=await ready();
    const pending=deferred<Awaited<ReturnType<typeof studioApi.listStarterSounds>>>();
    const installed={...asset,id:'new-prepared'};
    vi.spyOn(studioApi,'installStarterSounds').mockResolvedValue([installed]);
    vi.mocked(studioApi.listStarterSounds).mockReturnValue(pending.promise);
    const imported={...fixtureAsset(),id:'own-recording'};
    vi.spyOn(studioApi,'importAsset').mockResolvedValue(imported);
    let request!:Promise<void>;
    act(()=>{request=result.current.installStarterSounds();});
    await waitFor(()=>expect(studioApi.listStarterSounds).toHaveBeenCalledTimes(2));
    expect(result.current.assets.map(item=>item.id)).not.toContain(installed.id);
    await act(async()=>result.current.importFile(new File(['audio'],'own.wav'),{
      displayName:imported.displayName,roles:imported.roles,provenance:imported.provenance,rights:imported.rights,
    }));
    await act(async()=>{
      pending.resolve([{id:'prepared-rain',assetId:installed.id,preferredLoop:prepared}]);
      await request;
    });
    expect(result.current.assets.map(item=>item.id)).toEqual(expect.arrayContaining([installed.id,imported.id]));
    act(()=>result.current.addAsset(installed,'ambience'));
    expect(result.current.scene.layers[0]?.loop).toEqual(prepared);
  });

  it('preserves saved custom loops when opening a mix refreshes the catalog',async()=>{
    const saved=parseScene({...fixtureScene(),layers:[{...fixtureScene().layers[0],loop:{startSeconds:1,endSeconds:9,crossfadeSeconds:.1}}]});
    const {result}=await ready();
    vi.mocked(studioApi.listAssets).mockResolvedValue([asset]);
    vi.mocked(studioApi.getScene).mockResolvedValue(saved);
    vi.mocked(studioApi.listStarterSounds).mockResolvedValue(catalog);
    await act(async()=>result.current.openScene(saved.id));
    expect(result.current.scene).toEqual(saved);
    expect(result.current.dirty).toBe(false);
    expect(result.current.preferredLoops.get(asset.id)).toEqual(prepared);
  });

  it('ignores a default extending beyond the actual installed recording',async()=>{
    vi.mocked(studioApi.listStarterSounds).mockResolvedValue(catalog);
    const {result}=await ready();
    act(()=>result.current.addAsset(fixtureAsset(),'ambience'));
    expect(result.current.scene.layers[0]?.loop).toEqual({startSeconds:0,endSeconds:1.975,crossfadeSeconds:.02});
  });
});
afterEach(()=>vi.restoreAllMocks());

async function ready() {
  const hook=renderHook(()=>useSession());
  await waitFor(()=>expect(hook.result.current.status).toBe('ready'));
  return hook;
}

describe('saved session switching',()=>{
  it('versions edits synchronously and preserves saved authority separately from the current draft',async()=>{
    const {result}=await ready();
    const initial=result.current.getStateVersion();
    act(()=>{
      result.current.rename('Live draft');
      expect(result.current.getStateVersion()).toBe(initial+1);
      expect(result.current.getSnapshot()).toMatchObject({dirty:true,savedRevision:null,scene:{title:'Live draft'}});
    });
    vi.spyOn(studioApi,'createScene').mockImplementation(async scene=>parseScene({...scene,revision:1}));
    await act(async()=>result.current.save());
    expect(result.current.getSnapshot()).toMatchObject({stateVersion:initial+2,savedRevision:1,dirty:false});
    act(()=>result.current.edit({type:'setMasterGain',gain:.6}));
    expect(result.current.getSnapshot()).toMatchObject({stateVersion:initial+3,savedRevision:1,dirty:true});
  });

  it('does not replace edits made during a slow open or accept an expired open guard',async()=>{
    const {result}=await ready();const pending=deferred<Scene>();
    vi.mocked(studioApi.getScene).mockReturnValue(pending.promise);
    let opening!:Promise<Scene|null>;
    act(()=>{opening=result.current.openScene('other');result.current.rename('Keep newer title');});
    await act(async()=>{pending.resolve(empty('other','Other'));expect(await opening).toBeNull();});
    expect(result.current.getSnapshot().scene.title).toBe('Keep newer title');
    await act(async()=>expect(await result.current.openScene('other',()=>false)).toBeNull());
    expect(result.current.getSnapshot().scene.title).toBe('Keep newer title');
  });

  it('restores only the unchanged draft version and refuses an undo after a rename',async()=>{
    const {result}=await ready();const original=result.current.scene;
    act(()=>result.current.edit({type:'setMasterGain',gain:.6}));
    const version=result.current.getStateVersion();
    act(()=>result.current.restoreDraft(original,version));
    expect(result.current.scene).toEqual(original);
    expect(result.current.getStateVersion()).toBe(version+1);
    act(()=>result.current.rename('Newer edit'));
    expect(()=>result.current.restoreDraft(original,version+1)).toThrow(/changed/);
    expect(result.current.scene.title).toBe('Newer edit');
  });

  it('creates an independent transition draft and saves/copies its exact captured revisions',async()=>{
    vi.spyOn(studioApi,'createScene').mockImplementation(async scene=>parseScene({...scene,revision:1}));
    const {result}=await ready();
    const originalId=result.current.scene.id;
    act(()=>result.current.newTransition());
    expect(result.current.scene.id).not.toBe(originalId);
    expect(result.current.scene.title).toBe('Untitled transition');
    expect(result.current.dirty).toBe(false);
    const capture=parseCapturedMix({id:'capture-source',scene:fixtureScene(),assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]});
    act(()=>result.current.edit({type:'setTransition',transition:{...result.current.scene.transition!,a:capture}}));
    expect(result.current.scene.layers).toHaveLength(0);
    expect(result.current.dirty).toBe(true);
    expect(result.current.missingAssets).toEqual([]);
    await act(async()=>expect(await result.current.save()).toBe(true));
    const savedId=result.current.scene.id;
    expect(result.current.savedScenes[0]).toMatchObject({id:savedId,kind:'transition',layerCount:2});
    expect(result.current.dirty).toBe(false);
    await act(async()=>expect(await result.current.saveAsNew()).toBe(true));
    expect(result.current.scene.id).not.toBe(savedId);
    expect(result.current.scene.transition!.a).toEqual(capture);
    expect(result.current.scene.revision).toBe(1);
    expect(studioApi.createScene).toHaveBeenCalledTimes(2);
  });

  it('retains captured sources and unsaved arrangement settings after a revision conflict',async()=>{
    const {result}=await ready();
    act(()=>result.current.newTransition());
    const capture=parseCapturedMix({id:'capture-source',scene:fixtureScene(),assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]});
    const saved=parseScene({...result.current.scene,revision:4,transition:{...result.current.scene.transition!,a:capture,b:capture}});
    vi.mocked(studioApi.getScene).mockResolvedValue(saved);
    await act(async()=>result.current.openScene(saved.id));
    act(()=>result.current.edit({type:'setTransition',transition:{...result.current.scene.transition!,blend:.6}}));
    vi.spyOn(studioApi,'saveScene').mockRejectedValue(new StudioApiError('REVISION_CONFLICT',409,'New revision',5));
    await act(async()=>expect(await result.current.save()).toBe(false));
    expect(result.current.status).toBe('conflict');
    expect(result.current.scene.transition).toMatchObject({a:capture,b:capture,blend:.6});
    expect(result.current.scene.revision).toBe(4);
    expect(result.current.dirty).toBe(true);
  });

  it('reports missing saved alternates even in Standard mode and clears them when removed',async()=>{
    const {result}=await ready();
    act(()=>result.current.addAsset(fixtureAsset(),'ambience'));
    const id=result.current.scene.layers[0]!.id;
    const settings={...defaultOccasional(12),alternateAssetIds:['unavailable']};
    act(()=>result.current.edit({type:'setLayerOccasional',layerId:id,occasional:settings}));
    expect(result.current.missingAssets).toEqual(['unavailable']);
    act(()=>result.current.edit({type:'setLayerOccasional',layerId:id,occasional:{...settings,enabled:true}}));
    expect(result.current.missingAssets).toEqual(['unavailable']);
    act(()=>result.current.edit({type:'setLayerOccasional',layerId:id,occasional:{...settings,alternateAssetIds:[]}}));
    expect(result.current.missingAssets).toEqual([]);
  });

  it('keeps retained timer edits dirty in an empty session and saves them without countdown state',async()=>{
    const create=vi.spyOn(studioApi,'createScene').mockImplementation(async scene=>({...scene,revision:1}));
    const {result}=await ready();
    expect(result.current.dirty).toBe(false);
    const timer={enabled:true,durationSeconds:1800,fadeInSeconds:30,fadeOutSeconds:120};
    act(()=>result.current.edit({type:'setListeningTimer',timer}));
    expect(result.current.scene.layers).toHaveLength(0);expect(result.current.dirty).toBe(true);
    act(()=>result.current.edit({type:'setListeningTimer',timer:{...timer,enabled:false}}));
    expect(result.current.dirty).toBe(true);
    await act(async()=>expect(await result.current.save()).toBe(true));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({listeningTimer:{...timer,enabled:false},durationSeconds:null}));
    expect(result.current.dirty).toBe(false);expect(result.current.scene).not.toHaveProperty('remainingSeconds');
  });

  it('keeps output-limiter edits dirty before any sound is added and saves a retained bypass ceiling',async()=>{
    const create=vi.spyOn(studioApi,'createScene').mockImplementation(async scene=>({...scene,revision:1}));
    const {result}=await ready();
    expect(result.current.dirty).toBe(false);
    act(()=>result.current.edit({type:'setOutputLimiter',limiter:{enabled:true,ceilingDb:-1}}));
    expect(result.current.scene.layers).toHaveLength(0);
    expect(result.current.dirty).toBe(true);
    act(()=>result.current.edit({type:'setOutputLimiter',limiter:{enabled:false,ceilingDb:-3}}));
    expect(result.current.dirty).toBe(true);
    await act(async()=>expect(await result.current.save()).toBe(true));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({outputLimiter:{enabled:false,ceilingDb:-3}}));
    expect(result.current.dirty).toBe(false);
    act(()=>result.current.edit({type:'setOutputLimiter',limiter:{enabled:true,ceilingDb:-3}}));
    expect(result.current.dirty).toBe(true);
  });

  it('keeps master tone edits dirty before any sound is added and includes them in the saved recipe',async()=>{
    const create=vi.spyOn(studioApi,'createScene').mockImplementation(async scene=>({...scene,revision:1}));
    const {result}=await ready();
    expect(result.current.dirty).toBe(false);
    const equalizer={...flatEqualizer(),trebleDb:-3};
    act(()=>result.current.edit({type:'setMasterEqualizer',equalizer}));
    expect(result.current.scene.layers).toHaveLength(0);
    expect(result.current.dirty).toBe(true);
    await act(async()=>expect(await result.current.save()).toBe(true));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({masterEqualizer:equalizer}));
    expect(result.current.dirty).toBe(false);
    act(()=>result.current.edit({type:'setMasterEqualizer',equalizer:{...equalizer,bypassed:true}}));
    expect(result.current.dirty).toBe(true);
    expect(result.current.scene.masterEqualizer).toEqual({...equalizer,bypassed:true});
  });

  it('preserves the draft and declines switching while a save is pending',async()=>{
    const pending=deferred<Scene>();
    vi.spyOn(studioApi,'createScene').mockReturnValue(pending.promise);
    const {result}=await ready();
    act(()=>result.current.rename('First draft'));
    const submitted=result.current.scene;
    let saving!:Promise<boolean>;
    act(()=>{saving=result.current.save();});
    let opened:Scene|null=empty('unused','Unused');
    await act(async()=>{opened=await result.current.openScene('other');});
    expect(opened).toBeNull();
    act(()=>expect(result.current.newScene()).toBeNull());
    act(()=>result.current.edit({type:'setMasterGain',gain:.7}));
    await act(async()=>{pending.resolve({...submitted,revision:1});expect(await saving).toBe(false);});
    expect(result.current.scene.masterGain).toBe(.7);
    expect(result.current.scene.revision).toBe(1);
    expect(result.current.status).toBe('unsaved');
    expect(result.current.dirty).toBe(true);
    expect(result.current.savedScenes[0]?.title).toBe('First draft');
  });

  it('keeps the current unsaved scene when opening a different session fails',async()=>{
    const {result}=await ready();
    act(()=>result.current.rename('Keep this draft'));
    const previous=result.current.scene;
    await act(async()=>expect(await result.current.openScene('unavailable')).toBeNull());
    expect(result.current.scene).toEqual(previous);
    expect(result.current.dirty).toBe(true);
    expect(result.current.message).toMatch(/current session and unsaved changes are still here/);
  });

  it('does not let an older open request replace the newer selection',async()=>{
    const {result}=await ready();
    const older=deferred<Scene>();
    const newer=deferred<Scene>();
    vi.mocked(studioApi.getScene).mockImplementation(id=>id==='older'?older.promise:newer.promise);
    let first!:Promise<Scene|null>,second!:Promise<Scene|null>;
    act(()=>{first=result.current.openScene('older');second=result.current.openScene('newer');});
    await act(async()=>{newer.resolve(empty('newer','Newer session'));await second;});
    await act(async()=>{older.resolve(empty('older','Old result'));expect(await first).toBeNull();});
    expect(result.current.scene.id).toBe('newer');
    expect(result.current.status).toBe('saved');
    expect(localStorage.getItem('asmr-studio-selected-scene')).toBe('newer');
  });

  it('keeps an import that completes while starter sounds are being installed',async()=>{
    const {result}=await ready();
    const pending=deferred<ReturnType<typeof fixtureAsset>[]>();
    const install=vi.spyOn(studioApi,'installStarterSounds').mockReturnValue(pending.promise);
    const imported={...fixtureAsset(),id:'private-import',displayName:'Private recording'};
    vi.spyOn(studioApi,'importAsset').mockResolvedValue(imported);
    let request!:Promise<void>;
    act(()=>{request=result.current.installStarterSounds();expect(result.current.installStarterSounds()).toBe(request);});
    await act(async()=>result.current.importFile(new File(['audio'],'recording.wav'),{
      displayName:imported.displayName,roles:imported.roles,provenance:imported.provenance,rights:imported.rights,
    }));
    await act(async()=>{pending.resolve([fixtureAsset()]);await request;});
    expect(install).toHaveBeenCalledOnce();
    expect(result.current.assets.map(asset=>asset.id)).toContain('private-import');
  });
});
