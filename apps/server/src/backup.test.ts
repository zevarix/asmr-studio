import {afterEach,describe,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyScene,createEmptyTransition} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureLayer} from '../../../tests/fixtures/scene.js';
import {wavFixture} from '../../../tests/fixtures/audio.js';
import {openStore} from './store.js';
import {BackupError,backupLimits,createBackup,restoreBackup,verifyBackup,type BackupManifest} from './backup.js';

const roots:string[]=[];const stores:ReturnType<typeof openStore>[]=[];
afterEach(()=>{stores.splice(0).forEach(store=>store.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function fresh(){
  const parent=mkdtempSync(join(tmpdir(),'asmr-backup-test-'));roots.push(parent);
  const source=join(parent,'source');mkdirSync(source);const store=openStore(join(source,'studio.sqlite'));stores.push(store);
  const bytes=Buffer.from(wavFixture());const sha256=createHash('sha256').update(bytes).digest('hex');
  const asset={...fixtureAsset(),sha256,durationSeconds:.1};
  mkdirSync(join(source,'media','blobs'),{recursive:true});writeFileSync(join(source,'media','blobs',`${sha256}.wav`),bytes);
  store.assets.insert(asset,{bytes:bytes.length,mime:'audio/wav',extension:'wav'});
  const scene=store.scenes.create({...createEmptyScene('session','Saved session'),layers:[fixtureLayer({loop:{startSeconds:0,endSeconds:.1,crossfadeSeconds:.01}})]});
  return{parent,source,store,bytes,asset,scene,backup:join(parent,'backup'),restored:join(parent,'restored')};
}
function readManifest(root:string):BackupManifest{return JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')) as BackupManifest;}
function writeManifest(root:string,manifest:BackupManifest):void{writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest));}
function rehashDatabase(root:string):void{
  const manifest=readManifest(root),file=manifest.files.find(entry=>entry.path==='studio.sqlite')!,bytes=readFileSync(join(root,'studio.sqlite'));
  file.bytes=bytes.length;file.sha256=createHash('sha256').update(bytes).digest('hex');manifest.summary.totalBytes=manifest.files.reduce((sum,entry)=>sum+entry.bytes,0);writeManifest(root,manifest);
}
function assertNoStage(parent:string):void{expect(readdirSync(parent).filter(name=>name.startsWith('.asmr-'))).toEqual([]);}

describe('portable studio backup and restore',()=>{
  it('preserves exact media, IDs, rights, revisions and immutable captures while excluding active runtime state',async()=>{
    const f=fresh();
    const duplicate={...f.asset,id:'same-bytes-private',displayName:'My retained recording',provenance:{kind:'licensed' as const,source:'Private permission'},rights:{privateUse:'permitted' as const,redistribution:'forbidden' as const}};
    f.store.assets.insert(duplicate,{bytes:f.bytes.length,mime:'audio/wav',extension:'wav'});
    const captured=f.store.scenes.capture(f.scene.id,1),transition=createEmptyTransition('transition','Two mixes');
    const arrangement=f.store.scenes.create({...transition,transition:{...transition.transition!,a:captured,b:captured}});
    const newer=f.store.scenes.save({...f.scene,title:'Current source',masterGain:.4},1);
    mkdirSync(join(f.source,'starters','originals'),{recursive:true});mkdirSync(join(f.source,'starters','attribution'),{recursive:true});
    writeFileSync(join(f.source,'starters','originals','source.wav'),f.bytes);
    const credits=Buffer.from('{"sources":[]}\n'),creditsHash=createHash('sha256').update(credits).digest('hex');
    writeFileSync(join(f.source,'starters','attribution',`${creditsHash}.json`),credits);
    writeFileSync(join(f.source,'starters','attribution.json'),'legacy attribution');
    mkdirSync(join(f.source,'exports','running'),{recursive:true});writeFileSync(join(f.source,'exports','running','job.json'),'private running job');
    mkdirSync(join(f.source,'media','tmp'));writeFileSync(join(f.source,'media','tmp','in-progress.part'),'not complete');
    writeFileSync(join(f.source,'runtime-token.txt'),'not part of the library');
    const manifest=await createBackup({sourceRoot:f.source,destination:f.backup});
    expect(manifest.summary).toMatchObject({assets:2,scenes:2,capturedMixes:1,mediaFiles:1,sourceFiles:3});
    expect(await verifyBackup(f.backup)).toEqual(manifest);
    expect(existsSync(join(f.backup,'exports'))).toBe(false);expect(existsSync(join(f.backup,'media','tmp'))).toBe(false);expect(existsSync(join(f.backup,'runtime-token.txt'))).toBe(false);
    expect(readFileSync(join(f.backup,'media','blobs',`${f.asset.sha256}.wav`))).toEqual(f.bytes);
    // A later save does not rewrite the captured backup or the restored revision.
    f.store.scenes.save({...newer,title:'After backup'},newer.revision);
    expect(await restoreBackup({backupRoot:f.backup,destination:f.restored})).toEqual(manifest);
    const restored=openStore(join(f.restored,'studio.sqlite'));stores.push(restored);
    expect(restored.assets.list()).toEqual([f.asset,duplicate]);expect(restored.scenes.get(f.scene.id)).toEqual(newer);
    expect(restored.scenes.get(arrangement.id)).toEqual(arrangement);expect(restored.scenes.get(arrangement.id)?.transition?.a).toEqual(captured);
    expect(readFileSync(join(f.restored,'starters','originals','source.wav'))).toEqual(f.bytes);
    expect(readFileSync(join(f.restored,'starters','attribution',`${creditsHash}.json`))).toEqual(credits);
    expect(existsSync(join(f.restored,'manifest.json'))).toBe(false);
    if(process.platform!=='win32'){expect(statSync(f.backup).mode&0o777).toBe(0o700);expect(statSync(join(f.backup,'studio.sqlite')).mode&0o777).toBe(0o600);}
    assertNoStage(f.parent);
  });
  it('backs up a live WAL database while another connection saves and leaves the source usable',async()=>{
    const f=fresh(),writer=openStore(join(f.source,'studio.sqlite'));stores.push(writer);
    const pending=createBackup({sourceRoot:f.source,destination:f.backup});
    const saved=writer.scenes.save({...f.scene,title:'Concurrent save'},1);
    const manifest=await pending;expect(manifest.summary.scenes).toBe(1);
    await restoreBackup({backupRoot:f.backup,destination:f.restored});
    const restored=openStore(join(f.restored,'studio.sqlite'));stores.push(restored);
    expect(restored.scenes.get(saved.id)).toEqual(saved);
    expect(writer.scenes.save({...saved,title:'Still writable'},2).revision).toBe(3);
    expect(readFileSync(join(f.backup,'studio.sqlite')).subarray(18,20)).toEqual(Buffer.from([1,1]));
  });
  it('never replaces existing destinations, including an empty directory or the live library',async()=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});
    const before=readFileSync(join(f.source,'studio.sqlite'));
    await expect(createBackup({sourceRoot:f.source,destination:f.backup})).rejects.toMatchObject({code:'BACKUP_DESTINATION_EXISTS'});
    await expect(restoreBackup({backupRoot:f.backup,destination:f.source})).rejects.toMatchObject({code:'BACKUP_DESTINATION_EXISTS'});
    mkdirSync(f.restored);await expect(restoreBackup({backupRoot:f.backup,destination:f.restored})).rejects.toMatchObject({code:'BACKUP_DESTINATION_EXISTS'});
    expect(readdirSync(f.restored)).toEqual([]);expect(readFileSync(join(f.source,'studio.sqlite'))).toEqual(before);expect(f.store.scenes.get(f.scene.id)).toEqual(f.scene);
    await expect(createBackup({sourceRoot:f.source,destination:join(f.source,'nested')})).rejects.toMatchObject({code:'BACKUP_INVALID'});
    assertNoStage(f.parent);
  });
  it('allows only one concurrent backup or restore to publish the same destination',async()=>{
    const f=fresh();
    for(const operation of [
      ()=>createBackup({sourceRoot:f.source,destination:f.backup}),
      ()=>restoreBackup({backupRoot:f.backup,destination:f.restored}),
    ]){
      const results=await Promise.allSettled([operation(),operation()]);
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
      const failed=results.find(result=>result.status==='rejected');
      expect(failed?.status==='rejected'&&failed.reason).toMatchObject({code:'BACKUP_DESTINATION_EXISTS'});
      expect((await verifyBackup(f.backup)).summary).toMatchObject({assets:1,scenes:1,mediaFiles:1});
    }
    const restored=openStore(join(f.restored,'studio.sqlite'));stores.push(restored);
    expect(restored.scenes.get(f.scene.id)).toEqual(f.scene);
    expect(readFileSync(join(f.restored,'media','blobs',`${f.asset.sha256}.wav`))).toEqual(f.bytes);
    assertNoStage(f.parent);
  });
  it('round-trips a newly initialized library before any recordings are imported',async()=>{
    const parent=mkdtempSync(join(tmpdir(),'asmr-backup-empty-'));roots.push(parent);
    const source=join(parent,'source');const store=openStore(join(source,'studio.sqlite'));stores.push(store);
    const backup=join(parent,'backup'),restored=join(parent,'restored');
    const manifest=await createBackup({sourceRoot:source,destination:backup});
    expect(manifest.summary).toMatchObject({assets:0,scenes:0,capturedMixes:0,mediaFiles:0,sourceFiles:0});
    expect(manifest.files.map(file=>file.path)).toEqual(['studio.sqlite']);
    await restoreBackup({backupRoot:backup,destination:restored});
    const reopened=openStore(join(restored,'studio.sqlite'));stores.push(reopened);
    expect(reopened.assets.list()).toEqual([]);expect(reopened.scenes.list()).toEqual([]);
  });
  it('rejects a damaged media file before publishing a restore and preserves existing data',async()=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});
    const blob=join(f.backup,'media','blobs',`${f.asset.sha256}.wav`),damaged=Buffer.from(f.bytes);damaged[damaged.length-1]=damaged[damaged.length-1]!^1;writeFileSync(blob,damaged);
    await expect(verifyBackup(f.backup)).rejects.toMatchObject({code:'BACKUP_INTEGRITY'});
    await expect(restoreBackup({backupRoot:f.backup,destination:f.restored})).rejects.toMatchObject({code:'BACKUP_INTEGRITY'});
    expect(existsSync(f.restored)).toBe(false);expect(f.store.scenes.get(f.scene.id)).toEqual(f.scene);assertNoStage(f.parent);
  });
  it('cleans only owned staging after a missing or corrupt source blob and publishes no partial backup',async()=>{
    const f=fresh(),blob=join(f.source,'media','blobs',`${f.asset.sha256}.wav`);unlinkSync(blob);
    await expect(createBackup({sourceRoot:f.source,destination:f.backup})).rejects.toThrow();expect(existsSync(f.backup)).toBe(false);assertNoStage(f.parent);
    const broken=Buffer.from(f.bytes);broken[broken.length-1]=broken[broken.length-1]!^1;writeFileSync(blob,broken);
    await expect(createBackup({sourceRoot:f.source,destination:f.backup})).rejects.toMatchObject({code:'BACKUP_INTEGRITY'});expect(existsSync(f.backup)).toBe(false);assertNoStage(f.parent);
    expect(f.store.assets.list()).toEqual([f.asset]);
  });
  it('rejects path traversal, duplicate paths, and unsupported manifest versions',async()=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});const original=readManifest(f.backup);
    for(const modify of[
      (m:BackupManifest)=>{m.files[0]!.path='../outside.wav';},
      (m:BackupManifest)=>{m.files.push({...m.files[0]!});},
      (m:BackupManifest)=>{(m as {version:number}).version=2;},
    ]){const manifest=structuredClone(original);modify(manifest);writeManifest(f.backup,manifest);await expect(restoreBackup({backupRoot:f.backup,destination:f.restored})).rejects.toBeInstanceOf(BackupError);expect(existsSync(f.restored)).toBe(false);}
    expect(existsSync(join(f.parent,'outside.wav'))).toBe(false);assertNoStage(f.parent);
  });
  it('rejects symbolic links at the root, an intermediate media directory, and individual files',async()=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});
    const alias=join(f.parent,'alias');symlinkSync(f.backup,alias,'dir');await expect(verifyBackup(alias)).rejects.toMatchObject({code:'BACKUP_INVALID'});
    const blob=join(f.backup,'media','blobs',`${f.asset.sha256}.wav`);unlinkSync(blob);symlinkSync(join(f.source,'media','blobs',`${f.asset.sha256}.wav`),blob);
    await expect(verifyBackup(f.backup)).rejects.toMatchObject({code:'BACKUP_INVALID'});
    unlinkSync(blob);rmSync(join(f.backup,'media','blobs'),{recursive:true});symlinkSync(join(f.source,'media','blobs'),join(f.backup,'media','blobs'),'dir');
    await expect(restoreBackup({backupRoot:f.backup,destination:f.restored})).rejects.toMatchObject({code:'BACKUP_INVALID'});expect(existsSync(f.restored)).toBe(false);
  });
  it('rejects unlisted files and incomplete backup directories',async()=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});
    writeFileSync(join(f.backup,'extra.txt'),'unexpected');await expect(verifyBackup(f.backup)).rejects.toMatchObject({code:'BACKUP_INVALID'});unlinkSync(join(f.backup,'extra.txt'));
    unlinkSync(join(f.backup,'manifest.json'));await expect(restoreBackup({backupRoot:f.backup,destination:f.restored})).rejects.toThrow();expect(existsSync(f.restored)).toBe(false);
  });
  it.each(['trigger','version','document','reference'] as const)('rejects a rehashed database with an invalid %s',async variant=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});
    const db=new Database(join(f.backup,'studio.sqlite'));
    try{
      if(variant==='trigger')db.exec("CREATE TRIGGER unexpected AFTER INSERT ON scenes BEGIN DELETE FROM scenes; END");
      if(variant==='version')db.pragma('user_version = 99');
      if(variant==='document')db.prepare('UPDATE scenes SET document = ?').run('{broken');
      if(variant==='reference'){const scene={...f.scene,layers:[fixtureLayer({assetId:'missing'})]};db.prepare('UPDATE scenes SET document = ?').run(JSON.stringify(scene));}
    }finally{db.close();}
    rehashDatabase(f.backup);await expect(restoreBackup({backupRoot:f.backup,destination:f.restored})).rejects.toBeInstanceOf(BackupError);expect(existsSync(f.restored)).toBe(false);assertNoStage(f.parent);
  });
  it('does not create database sidecars or modify a valid backup while verifying',async()=>{
    const f=fresh();await createBackup({sourceRoot:f.source,destination:f.backup});
    const path=join(f.backup,'studio.sqlite'),before=statSync(path);await verifyBackup(f.backup);const after=statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);expect(after.ctimeMs).toBe(before.ctimeMs);expect(readdirSync(f.backup).sort()).toEqual(['manifest.json','media','studio.sqlite']);
    const bytes=readFileSync(path);bytes[18]=2;bytes[19]=2;writeFileSync(path,bytes);rehashDatabase(f.backup);
    await expect(verifyBackup(f.backup)).rejects.toMatchObject({code:'BACKUP_INVALID'});expect(existsSync(`${path}-wal`)).toBe(false);expect(existsSync(`${path}-shm`)).toBe(false);
  });
  it('rejects an attribution file whose digest name is false',async()=>{
    const f=fresh();mkdirSync(join(f.source,'starters','attribution'),{recursive:true});writeFileSync(join(f.source,'starters','attribution',`${'a'.repeat(64)}.json`),'{}');
    await expect(createBackup({sourceRoot:f.source,destination:f.backup})).rejects.toMatchObject({code:'BACKUP_INTEGRITY'});expect(existsSync(f.backup)).toBe(false);assertNoStage(f.parent);
  });
  it('bounds manifest reads before parsing and rejects symbolic-link source directories',async()=>{
    const f=fresh();mkdirSync(f.backup);writeFileSync(join(f.backup,'manifest.json'),' '.repeat(backupLimits.manifestBytes+1));
    await expect(verifyBackup(f.backup)).rejects.toMatchObject({code:'BACKUP_LIMIT'});
    const alias=join(f.parent,'source-link');symlinkSync(f.source,alias,'dir');expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    await expect(createBackup({sourceRoot:alias,destination:f.restored})).rejects.toMatchObject({code:'BACKUP_INVALID'});
  });
});
