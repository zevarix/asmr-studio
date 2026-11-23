import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import Database from 'better-sqlite3';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore, RevisionConflict, MissingAsset} from './store.js';
import {createEmptyScene,createEmptyTransition} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureLayer} from '../../../tests/fixtures/scene.js';

const roots:string[]=[];const stores:ReturnType<typeof openStore>[]=[];
function fresh(){const root=mkdtempSync(join(tmpdir(),'asmr-store-'));roots.push(root);const path=join(root,'studio.sqlite');const store=openStore(path);stores.push(store);return{root,path,store};}
afterEach(()=>{stores.splice(0).forEach(s=>s.close());roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function seed(store:ReturnType<typeof openStore>){const asset=fixtureAsset();store.assets.insert(asset,{bytes:100,mime:'audio/wav',extension:'wav'});return asset;}

describe('SQLite scene persistence',()=>{
  it('lists saved sessions with their latest titles and revisions without exposing media paths',()=>{
    const {store}=fresh();seed(store);
    expect(store.scenes.list()).toEqual([]);
    const original=store.scenes.create({...createEmptyScene('quiet-rain','Quiet rain'),layers:[fixtureLayer()]});
    store.scenes.create(createEmptyScene('paper','Paper'));
    store.scenes.save({...original,title:'Evening rain'},1);
    expect(store.scenes.list()).toEqual([
      {id:'paper',title:'Paper',revision:1,durationSeconds:null,layerCount:0,kind:'mix'},
      {id:'quiet-rain',title:'Evening rain',revision:2,durationSeconds:null,layerCount:1,kind:'mix'},
    ]);
  });
  it('creates revision one and reopens the exact scene and asset library',()=>{
    const {path,store}=fresh();seed(store);const input={...createEmptyScene('scene-1','Test'),layers:[fixtureLayer()]};
    const created=store.scenes.create(input);expect(created.revision).toBe(1);expect(input.revision).toBe(0);
    store.close();const reopened=openStore(path);stores.push(reopened);
    expect(reopened.scenes.get('scene-1')).toEqual(created);expect(reopened.assets.list()).toEqual([fixtureAsset()]);
    expect(reopened.scenes.get('missing')).toBeNull();
  });
  it('two writers at the same revision cannot overwrite each other',()=>{
    const {path,store}=fresh();const base=store.scenes.create(createEmptyScene('scene-1','Test'));
    const other=openStore(path);stores.push(other);
    const saved=store.scenes.save({...base,title:'First writer'},1);expect(saved.revision).toBe(2);
    expect(()=>other.scenes.save({...base,title:'Losing writer'},1)).toThrow(RevisionConflict);
    expect(other.scenes.get('scene-1')).toEqual(saved);
  });
  it('rejects missing asset references and out-of-asset loop endpoints without writes',()=>{
    const {store}=fresh();const base=createEmptyScene('scene-1','Test');
    expect(()=>store.scenes.create({...base,layers:[fixtureLayer()]})).toThrow(MissingAsset);
    expect(store.scenes.get('scene-1')).toBeNull();seed(store);
    expect(()=>store.scenes.create({...base,layers:[{...fixtureLayer(),loop:{startSeconds:0,endSeconds:3,crossfadeSeconds:0}}]})).toThrow();
    expect(store.scenes.get('scene-1')).toBeNull();
    const good=store.scenes.create(base);
    expect(()=>store.scenes.save({...good,layers:[{...fixtureLayer(),assetId:'missing'}]},1)).toThrow(MissingAsset);
    expect(store.scenes.get('scene-1')).toEqual(good);
  });
  it('rejects duplicate creation, unsafe revisions, and inconsistent revision envelopes',()=>{
    const {store}=fresh();const input=createEmptyScene('scene-1','Test');const created=store.scenes.create(input);
    expect(()=>store.scenes.create(input)).toThrow();
    for(const expected of [0,-1,NaN,Infinity,1.5])expect(()=>store.scenes.save(created,expected)).toThrow();
    expect(()=>store.scenes.save({...created,revision:2},1)).toThrow();
    expect(store.scenes.get('scene-1')).toEqual(created);
  });
  it('upgrades a version-one database without changing ordinary scenes',()=>{
    const root=mkdtempSync(join(tmpdir(),'asmr-store-v1-'));roots.push(root);
    const path=join(root,'studio.sqlite'),old=new Database(path);
    old.exec(readFileSync(new URL('./migrations/001-initial.sql',import.meta.url),'utf8'));
    const scene={...createEmptyScene('old','Existing mix'),revision:1};
    old.prepare('INSERT INTO scenes (id, revision, document) VALUES (?, ?, ?)').run(scene.id,scene.revision,JSON.stringify(scene));
    old.close();
    const store=openStore(path);stores.push(store);
    expect(store.scenes.get(scene.id)).toEqual(scene);
    const capture=store.scenes.capture(scene.id,1);
    expect(capture.scene).toEqual(scene);expect(capture.assets).toEqual([]);
    const inspect=new Database(path,{readonly:true});
    try {expect(inspect.pragma('user_version',{simple:true})).toBe(2);}
    finally {inspect.close();}
  });
  it('preserves immutable captures and copies after their sources change and the store reopens',()=>{
    const {path,store}=fresh(),asset=seed(store);
    const alternate={...asset,id:'alternate',provenance:{kind:'licensed' as const,source:'Another creator'}};
    store.assets.insert(alternate,{bytes:100,mime:'audio/wav',extension:'wav'});
    const source=store.scenes.create({...createEmptyScene('source','Source'),layers:[{...fixtureLayer(),occasional:{enabled:false,
      minPauseSeconds:4,maxPauseSeconds:12,seed:1,alternateAssetIds:[alternate.id],levelVariation:0,panVariation:0}}]});
    const capture=store.scenes.capture(source.id,source.revision),original=structuredClone(capture);
    expect(capture.assets).toEqual([asset,alternate]);
    const empty=createEmptyTransition('arrangement','A to B');
    const saved=store.scenes.create({...empty,transition:{...empty.transition!,a:capture,b:capture}});
    store.scenes.save({...source,title:'Source edited',masterGain:.9},source.revision);
    const edited=store.scenes.save({...saved,title:'Independent arrangement'},saved.revision);
    const copy=store.scenes.create({...edited,id:'copy',revision:0});
    expect(copy.transition?.a).toEqual(original);
    capture.scene.title='Caller mutation';capture.assets[0]!.provenance.source='Caller mutation';
    expect(store.scenes.get(saved.id)?.transition?.a).toEqual(original);
    store.close();const reopened=openStore(path);stores.push(reopened);
    expect(reopened.scenes.get(copy.id)).toEqual(copy);
    expect(reopened.scenes.list().find(summary=>summary.id===copy.id)).toMatchObject({kind:'transition',layerCount:2});
  });
  it('rejects forged captures, nested sources, stale capture revisions, and changes of scene kind without writes',()=>{
    const {store}=fresh();seed(store);
    const source=store.scenes.create({...createEmptyScene('source','Source'),layers:[fixtureLayer()]});
    const capture=store.scenes.capture(source.id,source.revision);
    expect(()=>store.scenes.capture(source.id,0)).toThrow();
    expect(()=>store.scenes.capture('missing',1)).toThrow();
    store.scenes.save({...source,title:'Changed'},1);
    expect(()=>store.scenes.capture(source.id,1)).toThrow(RevisionConflict);
    const empty=createEmptyTransition('arrangement','A to B');
    for(const forged of [{...capture,id:'invented'}, {...capture,scene:{...capture.scene,masterGain:.75}},
      {...capture,assets:[{...capture.assets[0]!,provenance:{kind:'original' as const,source:'Forged attribution'}}]}]){
      expect(()=>store.scenes.create({...empty,transition:{...empty.transition!,a:forged}})).toThrow();
      expect(store.scenes.get(empty.id)).toBeNull();
    }
    const saved=store.scenes.create({...empty,transition:{...empty.transition!,a:capture}});
    expect(()=>store.scenes.capture(saved.id,1)).toThrow();
    expect(()=>store.scenes.save({...createEmptyScene(saved.id,'Changed kind'),revision:1},1)).toThrow();
    const normal=store.scenes.create(createEmptyScene('normal','Normal'));
    expect(()=>store.scenes.save({...createEmptyTransition(normal.id,'Changed kind'),revision:1},1)).toThrow();
    expect(store.scenes.get(saved.id)).toEqual(saved);expect(store.scenes.get(normal.id)).toEqual(normal);
    const first=store.scenes.save({...saved,title:'First writer'},1);
    expect(()=>store.scenes.save({...saved,title:'Stale writer'},1)).toThrow(RevisionConflict);
    expect(store.scenes.get(saved.id)).toEqual(first);
  });
});
