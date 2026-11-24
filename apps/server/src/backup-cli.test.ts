import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEmptyScene} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureLayer} from '../../../tests/fixtures/scene.js';
import {wavFixture} from '../../../tests/fixtures/audio.js';
import {openStore} from './store.js';

const cli=fileURLToPath(new URL('../dist/backup-cli.js',import.meta.url));
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

function workspace():string {
  const root=mkdtempSync(join(tmpdir(),'asmr backup cli '));
  roots.push(root);
  return root;
}

function library(root:string,id:string) {
  mkdirSync(join(root,'media','blobs'),{recursive:true});
  const bytes=Buffer.from(wavFixture());
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const asset={...fixtureAsset(),id:`recording-${id}`,sha256,durationSeconds:.1};
  writeFileSync(join(root,'media','blobs',`${sha256}.wav`),bytes);
  const store=openStore(join(root,'studio.sqlite'));
  try {
    store.assets.insert(asset,{bytes:bytes.length,mime:'audio/wav',extension:'wav'});
    const first=store.scenes.create({...createEmptyScene(`session-${id}`,`Session ${id}`),
      layers:[fixtureLayer({assetId:asset.id})]});
    const scene=store.scenes.save({...first,title:`Saved revision for ${id}`,masterGain:.35},first.revision);
    return {root,asset,scene,bytes};
  } finally {store.close();}
}

function run(root:string,dataRoot:string,args:string[]) {
  const result=spawnSync(process.execPath,[cli,...args],{
    cwd:root,
    env:{...process.env,ASMR_DATA_DIR:dataRoot,HOME:join(root,'isolated home'),USERPROFILE:join(root,'isolated home')},
    encoding:'utf8',timeout:10_000,maxBuffer:1024*1024,windowsHide:true,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('backup command-line entry point',()=>{
  it('creates, verifies and restores paths with spaces from the selected data directory',()=>{
    const root=workspace();
    const selected=library(join(root,'selected studio data'),'selected');
    const other=library(join(root,'isolated home','.local','share','asmr-studio'),'other');
    const backup=join(root,'backup with spaces');
    const restored=join(root,'restored studio data');

    const created=run(root,selected.root,['create','backup with spaces']);
    expect(created.status).toBe(0);
    expect(created.stdout).toContain(`Backup created: ${backup}`);
    expect(created.stdout).toContain('1 recordings, 1 saved sessions');
    const verified=run(root,other.root,['verify','backup with spaces']);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain(`Backup verified: ${backup}`);
    const result=run(root,other.root,['restore','backup with spaces','restored studio data']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Library restored: ${restored}`);

    const store=openStore(join(restored,'studio.sqlite'));
    try {
      expect(store.assets.list()).toEqual([selected.asset]);
      expect(store.scenes.get(selected.scene.id)).toEqual(selected.scene);
      expect(store.scenes.get(other.scene.id)).toBeNull();
    } finally {store.close();}
    expect(readFileSync(join(restored,'media','blobs',`${selected.asset.sha256}.wav`))).toEqual(selected.bytes);
    const untouched=openStore(join(other.root,'studio.sqlite'));
    try {expect(untouched.scenes.get(other.scene.id)).toEqual(other.scene);}
    finally {untouched.close();}
    expect(readdirSync(root).filter(name=>name.startsWith('.asmr-'))).toEqual([]);
  });

  it('returns a failure for damaged backup bytes without publishing a restore',()=>{
    const root=workspace();
    const source=library(join(root,'source data'),'source');
    const backup=join(root,'backup');
    expect(run(root,source.root,['create',backup]).status).toBe(0);
    const media=join(backup,'media','blobs',`${source.asset.sha256}.wav`);
    const damaged=Buffer.from(source.bytes);
    damaged[damaged.length-1]=damaged[damaged.length-1]!^1;
    writeFileSync(media,damaged);

    const verified=run(root,source.root,['verify',backup]);
    expect(verified.status).toBe(1);
    expect(verified.stdout).not.toContain('Backup verified:');
    expect(verified.stderr).toContain('integrity check');
    const destination=join(root,'restore must not appear');
    const restored=run(root,source.root,['restore',backup,destination]);
    expect(restored.status).toBe(1);
    expect(restored.stdout).not.toContain('Library restored:');
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(source.root,'media','blobs',`${source.asset.sha256}.wav`))).toEqual(source.bytes);
  });

  it('refuses an existing destination and leaves its contents intact',()=>{
    const root=workspace();
    const source=library(join(root,'source data'),'source');
    const backup=join(root,'backup');
    expect(run(root,source.root,['create',backup]).status).toBe(0);
    const originalManifest=readFileSync(join(backup,'manifest.json'));
    const createAgain=run(root,source.root,['create',backup]);
    expect(createAgain.status).toBe(1);
    expect(createAgain.stderr).toContain('destination already exists');
    expect(readFileSync(join(backup,'manifest.json'))).toEqual(originalManifest);

    const destination=join(root,'existing folder');
    mkdirSync(destination);writeFileSync(join(destination,'keep.txt'),'unrelated existing data');
    const restored=run(root,source.root,['restore',backup,destination]);
    expect(restored.status).toBe(1);
    expect(restored.stderr).toContain('destination already exists');
    expect(readdirSync(destination)).toEqual(['keep.txt']);
    expect(readFileSync(join(destination,'keep.txt'),'utf8')).toBe('unrelated existing data');
  });

  it.each([
    [],['create'],['create','destination','extra'],['verify'],
    ['verify','backup','extra'],['restore','backup'],['restore','backup','destination','extra'],
    ['unknown','destination'],
  ].map(args=>({args})))('rejects invalid arguments $args without creating data or destinations',({args})=>{
    const root=workspace();
    const source=join(root,'source must not appear');
    const result=run(root,source,args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Choose create, verify, or restore');
    expect(result.stdout).toBe('');
    expect(readdirSync(root)).toEqual([]);
  });

  it('prints help without opening or creating the configured data directory',()=>{
    const root=workspace();
    const result=run(root,join(root,'source must not appear'),['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run backup -- restore');
    expect(readdirSync(root)).toEqual([]);
  });
});
