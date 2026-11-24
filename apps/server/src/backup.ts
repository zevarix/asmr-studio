import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {closeSync,constants,openSync,readFileSync,readSync} from 'node:fs';
import {chmod,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {layerAssetIds,parseAssetRecord,parseCapturedMix,parseScene,type AssetRecord,type MixScene} from '@asmr-studio/contracts';

export interface BackupFile {path:string;bytes:number;sha256:string}
export interface BackupSummary {assets:number;scenes:number;capturedMixes:number;mediaFiles:number;sourceFiles:number;totalBytes:number}
export interface BackupManifest {
  format:'asmr-studio-backup';version:1;createdAt:string;databaseVersion:2;
  summary:BackupSummary;files:BackupFile[];
}
type BackupErrorCode='BACKUP_INVALID'|'BACKUP_INTEGRITY'|'BACKUP_DESTINATION_EXISTS'|'BACKUP_SOURCE_UNAVAILABLE'|'BACKUP_LIMIT';
export class BackupError extends Error {
  constructor(readonly code:BackupErrorCode,message:string){super(message);this.name='BackupError';}
}
export const backupLimits={manifestBytes:16*1024*1024,entries:100_000,documentBytes:8*1024*1024} as const;
const digestPattern=/^[a-f0-9]{64}$/;
const blobPattern=/^media\/blobs\/([a-f0-9]{64})\.([a-z0-9]+)$/;
const sourcePattern=/^starters\/originals\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const attributionPattern=/^starters\/attribution\/([a-f0-9]{64})\.json$/;
const directories=new Set(['media','media/blobs','starters','starters/originals','starters/attribution']);
function fail(code:BackupErrorCode,message:string):never {throw new BackupError(code,message);}
function isMissing(error:unknown):boolean{return(error as NodeJS.ErrnoException).code==='ENOENT';}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function keysAre(value:Record<string,unknown>,keys:readonly string[]):boolean{return Object.keys(value).sort().join('|')===[...keys].sort().join('|');}
function positive(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
function count(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function filePath(path:string):boolean{return path==='studio.sqlite'||blobPattern.test(path)||sourcePattern.test(path)||attributionPattern.test(path)||path==='starters/attribution.json';}

async function privateRoot(path:string):Promise<string>{
  const absolute=resolve(path);
  const stat=await lstat(absolute).catch(()=>fail('BACKUP_SOURCE_UNAVAILABLE','The source directory is unavailable.'));
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('BACKUP_INVALID','Backup storage must use real directories, not symbolic links.');
  return realpath(absolute);
}
async function pathWithin(root:string,path:string):Promise<string>{
  if(!filePath(path)&&path!=='manifest.json')fail('BACKUP_INVALID','The backup contains an unsupported path.');
  const parts=path.split('/');let current=root;
  for(const part of parts.slice(0,-1)){
    current=join(current,part);const stat=await lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('BACKUP_INVALID','Backup paths must not cross symbolic links.');
  }
  return join(current,parts.at(-1)!);
}
async function safeOpen(root:string,path:string):Promise<FileHandle>{
  const full=await pathWithin(root,path);
  const entry=await lstat(full);if(!entry.isFile()||entry.isSymbolicLink())fail('BACKUP_INVALID','Backup entries must be regular files, not symbolic links.');
  const handle=await open(full,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=await handle.stat();if(!stat.isFile())fail('BACKUP_INVALID','Backup entries must be regular files.');return handle;}
  catch(error){await handle.close();throw error;}
}
async function hashOrCopy(root:string,path:string,destinationRoot?:string,expected?:Pick<BackupFile,'bytes'|'sha256'>):Promise<BackupFile>{
  const input=await safeOpen(root,path);let output:FileHandle|undefined;
  try{
    const before=await input.stat();
    if(!positive(before.size)||(expected&&before.size!==expected.bytes))fail('BACKUP_INTEGRITY','A backup file has an unexpected size.');
    if(destinationRoot){const destination=join(destinationRoot,...path.split('/'));await mkdir(dirname(destination),{recursive:true,mode:0o700});output=await open(destination,'wx',0o600);}
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of input.createReadStream({autoClose:false})){
      bytes+=chunk.length;
      if(!Number.isSafeInteger(bytes)||bytes>before.size)fail('BACKUP_INTEGRITY','A source file changed while it was being copied.');
      hash.update(chunk);if(output)await output.writeFile(chunk);
    }
    const after=await input.stat();const sha256=hash.digest('hex');
    if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||
      (expected&&sha256!==expected.sha256))fail('BACKUP_INTEGRITY','A backup file failed its SHA-256 integrity check.');
    const namedDigest=blobPattern.exec(path)?.[1]??attributionPattern.exec(path)?.[1];
    if(namedDigest&&namedDigest!==sha256)fail('BACKUP_INTEGRITY','A content-addressed file does not match its filename.');
    await output?.sync();return{path,bytes,sha256};
  }finally{await output?.close();await input.close();}
}
function parseManifest(value:unknown):BackupManifest{
  if(!isRecord(value)||!keysAre(value,['format','version','createdAt','databaseVersion','summary','files'])||
    value.format!=='asmr-studio-backup'||value.version!==1||value.databaseVersion!==2||typeof value.createdAt!=='string'||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)||!Number.isFinite(Date.parse(value.createdAt))||
    !isRecord(value.summary)||!keysAre(value.summary,['assets','scenes','capturedMixes','mediaFiles','sourceFiles','totalBytes'])||
    !Object.values(value.summary).every(count)||!Array.isArray(value.files))fail('BACKUP_INVALID','The backup manifest is invalid or uses an unsupported version.');
  if(value.files.length>backupLimits.entries)fail('BACKUP_LIMIT','The backup has too many files.');
  let previous='';let total=0;
  for(const file of value.files){
    if(!isRecord(file)||!keysAre(file,['path','bytes','sha256'])||typeof file.path!=='string'||!filePath(file.path)||file.path<=previous||
      !positive(file.bytes)||typeof file.sha256!=='string'||!digestPattern.test(file.sha256))fail('BACKUP_INVALID','The backup file list is invalid, duplicated, or unsorted.');
    previous=file.path;total+=file.bytes;if(!Number.isSafeInteger(total))fail('BACKUP_LIMIT','The backup byte total is too large.');
  }
  const manifest=value as unknown as BackupManifest;
  if(manifest.files.filter(file=>file.path==='studio.sqlite').length!==1||manifest.summary.totalBytes!==total||
    manifest.summary.mediaFiles!==manifest.files.filter(file=>blobPattern.test(file.path)).length||
    manifest.summary.sourceFiles!==manifest.files.filter(file=>file.path.startsWith('starters/')).length)
    fail('BACKUP_INVALID','The backup summary does not match its file list.');
  return manifest;
}
async function loadManifest(root:string):Promise<BackupManifest>{
  const handle=await safeOpen(root,'manifest.json');
  try{
    const stat=await handle.stat();if(stat.size>backupLimits.manifestBytes)fail('BACKUP_LIMIT','The backup manifest exceeds the supported size.');
    let value:unknown;try{value=JSON.parse(await handle.readFile('utf8'));}catch{fail('BACKUP_INVALID','The backup manifest is not valid JSON.');}
    return parseManifest(value);
  }finally{await handle.close();}
}
async function allBackupFiles(root:string):Promise<string[]>{
  const files:string[]=[];
  async function visit(path:string):Promise<void>{
    for(const entry of await readdir(join(root,...path.split('/').filter(Boolean)),{withFileTypes:true})){
      const child=path?`${path}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())fail('BACKUP_INVALID','The backup contains a symbolic link.');
      if(entry.isDirectory()){if(!directories.has(child))fail('BACKUP_INVALID','The backup contains an unexpected directory.');await visit(child);}
      else if(entry.isFile()&&(filePath(child)||child==='manifest.json')){files.push(child);if(files.length>backupLimits.entries+1)fail('BACKUP_LIMIT','The backup has too many files.');}
      else fail('BACKUP_INVALID','The backup contains an unsupported entry.');
    }
  }
  await visit('');return files.sort();
}
function jsonDocument(value:unknown):unknown{
  if(typeof value!=='string'||Buffer.byteLength(value)>backupLimits.documentBytes)fail('BACKUP_LIMIT','A stored document exceeds the supported size.');
  try{return JSON.parse(value);}catch{fail('BACKUP_INVALID','The database contains an invalid JSON document.');}
}
function expectedSchema():string{
  const db=new Database(':memory:');
  try{
    db.exec(readFileSync(new URL('./migrations/001-initial.sql',import.meta.url),'utf8'));
    db.exec(readFileSync(new URL('./migrations/002-captured-mixes.sql',import.meta.url),'utf8'));
    return schemaIdentity(db);
  }finally{db.close();}
}
function schemaIdentity(db:Database.Database):string{
  return JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
}
interface StoredBlob{sha256:string;bytes:number;mime:string;extension:string}
interface AssetRow{id:string;sha256:string;display_name:string;roles_json:string;duration_seconds:number;sample_rate:number;channels:number;format:string;provenance_kind:string;source:string|null;private_use:string;redistribution:string}
interface DatabaseInventory{assets:number;scenes:number;capturedMixes:number;blobs:StoredBlob[]}
function inspectDatabase(path:string):DatabaseInventory{
  // Reject WAL-mode files before SQLite opens them: verification must not create
  // a shared-memory sidecar or read content outside the manifest.
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const header=Buffer.alloc(20);if(readSync(fd,header,0,20,0)!==20||header.subarray(0,16).toString('binary')!=='SQLite format 3\0'||header[18]!==1||header[19]!==1)
    fail('BACKUP_INVALID','The backup database must be a standalone SQLite file.');}
  finally{closeSync(fd);}
  const db=new Database(path,{readonly:true,fileMustExist:true});
  try{
    db.pragma('trusted_schema = OFF');db.pragma('query_only = ON');
    if(db.pragma('user_version',{simple:true})!==2||db.pragma('journal_mode',{simple:true})!=='delete'||schemaIdentity(db)!==expectedSchema())
      fail('BACKUP_INVALID','The backup database schema is unsupported or has been modified.');
    const foreignKeys=db.pragma('foreign_key_check');
    if(db.pragma('quick_check',{simple:true})!=='ok'||!Array.isArray(foreignKeys)||foreignKeys.length!==0)fail('BACKUP_INTEGRITY','The backup database failed its integrity check.');
    for(const table of ['blobs','assets','scenes','captured_mixes']){
      const rows=db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
      if(!count(rows)||rows>backupLimits.entries)fail('BACKUP_LIMIT','The database has too many stored records.');
    }
    const blobs=db.prepare<[],StoredBlob>('SELECT sha256,bytes,mime,extension FROM blobs ORDER BY sha256').all();
    const blobMap=new Map(blobs.map(blob=>[blob.sha256,blob]));
    for(const blob of blobs)if(!digestPattern.test(blob.sha256)||!positive(blob.bytes)||!/^[a-z0-9]+$/.test(blob.extension)||!/^audio\/[a-z0-9.+-]+$/.test(blob.mime))
      fail('BACKUP_INVALID','The database contains invalid audio storage metadata.');
    const assets=new Map<string,AssetRecord>();
    for(const row of db.prepare<[],AssetRow>('SELECT * FROM assets').iterate()){
      const asset=parseAssetRecord({id:row.id,sha256:row.sha256,displayName:row.display_name,roles:jsonDocument(row.roles_json),durationSeconds:row.duration_seconds,
        sampleRate:row.sample_rate,channels:row.channels,format:row.format,provenance:{kind:row.provenance_kind,source:row.source},rights:{privateUse:row.private_use,redistribution:row.redistribution}});
      if(!blobMap.has(asset.sha256))fail('BACKUP_INTEGRITY','An audio record has no stored content.');assets.set(asset.id,asset);
    }
    function checkMix(scene:MixScene):void{
      for(const layer of scene.layers){
        for(const id of layerAssetIds(layer))if(!assets.has(id))fail('BACKUP_INTEGRITY','A saved mix references missing audio.');
        if(layer.loop&&layer.loop.endSeconds>assets.get(layer.assetId)!.durationSeconds)fail('BACKUP_INVALID','A saved loop extends beyond its recording.');
      }
    }
    const captures=new Map<string,string>();
    for(const row of db.prepare<[],{id:string;document:string}>('SELECT id,document FROM captured_mixes').iterate()){
      const capture=parseCapturedMix(jsonDocument(row.document));
      if(capture.id!==row.id)fail('BACKUP_INVALID','A captured mix has an inconsistent identity.');
      checkMix(capture.scene);
      for(const asset of capture.assets)if(JSON.stringify(asset)!==JSON.stringify(assets.get(asset.id)))fail('BACKUP_INTEGRITY','A captured mix does not match its retained audio records.');
      captures.set(capture.id,JSON.stringify(capture));
    }
    let scenes=0;
    for(const row of db.prepare<[],{id:string;revision:number;document:string}>('SELECT id,revision,document FROM scenes').iterate()){
      const scene=parseScene(jsonDocument(row.document));
      if(scene.id!==row.id||scene.revision!==row.revision||scene.revision<1)fail('BACKUP_INVALID','A saved session has an inconsistent identity or revision.');
      if(scene.transition){for(const capture of[scene.transition.a,scene.transition.b])if(capture&&captures.get(capture.id)!==JSON.stringify(capture))fail('BACKUP_INTEGRITY','A transition references a missing or changed captured mix.');}
      else checkMix(scene);scenes++;
    }
    return{assets:assets.size,scenes,capturedMixes:captures.size,blobs};
  }catch(error){if(error instanceof BackupError)throw error;fail('BACKUP_INVALID','The backup database could not be validated.');}
  finally{db.close();}
}
function checkInventory(manifest:BackupManifest,inventory:DatabaseInventory):void{
  for(const key of ['assets','scenes','capturedMixes'] as const)if(manifest.summary[key]!==inventory[key])fail('BACKUP_INTEGRITY','The manifest does not match its saved sessions and audio records.');
  const files=new Map(manifest.files.filter(file=>blobPattern.test(file.path)).map(file=>[file.path,file]));
  if(files.size!==inventory.blobs.length)fail('BACKUP_INTEGRITY','The backup does not contain exactly the registered media blobs.');
  for(const blob of inventory.blobs){const file=files.get(`media/blobs/${blob.sha256}.${blob.extension}`);if(!file||file.sha256!==blob.sha256||file.bytes!==blob.bytes)fail('BACKUP_INTEGRITY','A registered audio blob is missing or differs from its manifest.');}
}
async function verifyRoot(root:string):Promise<BackupManifest>{
  const manifest=await loadManifest(root);
  const expected=['manifest.json',...manifest.files.map(file=>file.path)].sort();
  if(JSON.stringify(await allBackupFiles(root))!==JSON.stringify(expected))fail('BACKUP_INVALID','The backup has missing or unlisted files.');
  for(const file of manifest.files)await hashOrCopy(root,file.path,undefined,file);
  checkInventory(manifest,inspectDatabase(join(root,'studio.sqlite')));return manifest;
}
export async function verifyBackup(directory:string):Promise<BackupManifest>{return verifyRoot(await privateRoot(directory));}

async function destinationPath(destination:string,source:string):Promise<string>{
  const absolute=resolve(destination);const parent=await privateRoot(dirname(absolute));const path=join(parent,basename(absolute));
  const overlap=(a:string,b:string)=>{const r=relative(a,b);return r===''||(!r.startsWith(`..${sep}`)&&r!=='..'&&!isAbsolute(r));};
  if(overlap(source,path)||overlap(path,source))fail('BACKUP_INVALID','Source and destination directories must be separate.');
  try{await lstat(path);fail('BACKUP_DESTINATION_EXISTS','The destination already exists; choose a new directory.');}catch(error){if(!isMissing(error))throw error;}
  return path;
}
async function publish(stage:string,destination:string,backup:boolean):Promise<void>{
  // mkdir is the portable exclusive reservation. rename alone could replace an
  // unrelated empty directory created after an existence check.
  try{await mkdir(destination,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')fail('BACKUP_DESTINATION_EXISTS','The destination already exists; choose a new directory.');throw error;}
  const owned=await lstat(destination);let complete=false;
  try{
    for(const entry of await readdir(stage)){if(entry==='manifest.json'||entry==='studio.sqlite')continue;await rename(join(stage,entry),join(destination,entry));}
    // Publish the database only after all referenced recordings are in place.
    await rename(join(stage,'studio.sqlite'),join(destination,'studio.sqlite'));
    // Exclusive creation also works on backup volumes without hard-link support.
    // An interrupted manifest write is incomplete and fails normal verification.
    if(backup){
      const manifest=await open(join(destination,'manifest.json'),'wx',0o600);
      try{await manifest.writeFile(await readFile(join(stage,'manifest.json')));await manifest.sync();}
      finally{await manifest.close();}
    }
    complete=true;
  }finally{
    if(!complete){const current=await lstat(destination).catch(()=>null);if(current?.dev===owned.dev&&current.ino===owned.ino)await rm(destination,{recursive:true,force:true});}
  }
}
async function starterFiles(root:string):Promise<string[]>{
  const result:string[]=[];
  const base=join(root,'starters');
  let baseStat;try{baseStat=await lstat(base);}catch(error){if(isMissing(error))return result;throw error;}
  if(!baseStat.isDirectory()||baseStat.isSymbolicLink())fail('BACKUP_INVALID','Starter storage must not be a symbolic link.');
  for(const folder of ['originals','attribution']){
    let stat;try{stat=await lstat(join(base,folder));}catch(error){if(isMissing(error))continue;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('BACKUP_INVALID','Starter storage must use real directories.');
    for(const entry of await readdir(join(base,folder),{withFileTypes:true})){
      const path=`starters/${folder}/${entry.name}`;
      if(!entry.isFile()||entry.isSymbolicLink()||!filePath(path))fail('BACKUP_INVALID','Starter storage contains an unsupported entry.');
      result.push(path);if(result.length>backupLimits.entries)fail('BACKUP_LIMIT','There are too many starter source files.');
    }
  }
  try{const legacy=await lstat(join(base,'attribution.json'));if(!legacy.isFile()||legacy.isSymbolicLink())fail('BACKUP_INVALID','Starter attribution must be a regular file.');result.push('starters/attribution.json');}
  catch(error){if(!isMissing(error))throw error;}
  return result.sort();
}
export async function createBackup(options:{sourceRoot:string;destination:string}):Promise<BackupManifest>{
  const source=await privateRoot(options.sourceRoot);const destination=await destinationPath(options.destination,source);
  const stage=await mkdtemp(join(dirname(destination),'.asmr-backup-'));await chmod(stage,0o700);
  try{
    const original=await safeOpen(source,'studio.sqlite');await original.close();
    const db=new Database(join(source,'studio.sqlite'),{readonly:true,fileMustExist:true,timeout:5000});
    try{db.pragma('trusted_schema = OFF');db.pragma('query_only = ON');await db.backup(join(stage,'studio.sqlite'));}finally{db.close();}
    await chmod(join(stage,'studio.sqlite'),0o600);
    const portable=new Database(join(stage,'studio.sqlite'),{fileMustExist:true});
    try{portable.pragma('trusted_schema = OFF');portable.pragma('journal_mode = DELETE');}finally{portable.close();}
    const inventory=inspectDatabase(join(stage,'studio.sqlite'));
    const files:BackupFile[]=[await hashOrCopy(stage,'studio.sqlite')];
    for(const blob of inventory.blobs)files.push(await hashOrCopy(source,`media/blobs/${blob.sha256}.${blob.extension}`,stage,{bytes:blob.bytes,sha256:blob.sha256}));
    for(const path of await starterFiles(source))files.push(await hashOrCopy(source,path,stage));
    files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const manifest=parseManifest({format:'asmr-studio-backup',version:1,createdAt:new Date().toISOString(),databaseVersion:2,
      summary:{assets:inventory.assets,scenes:inventory.scenes,capturedMixes:inventory.capturedMixes,mediaFiles:inventory.blobs.length,
        sourceFiles:files.filter(file=>file.path.startsWith('starters/')).length,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)},files});
    const json=JSON.stringify(manifest,null,2)+'\n';if(Buffer.byteLength(json)>backupLimits.manifestBytes)fail('BACKUP_LIMIT','The backup manifest exceeds the supported size.');
    const handle=await open(join(stage,'manifest.json'),'wx',0o600);try{await handle.writeFile(json);await handle.sync();}finally{await handle.close();}
    await verifyRoot(stage);await publish(stage,destination,true);return manifest;
  }finally{await rm(stage,{recursive:true,force:true});}
}
export async function restoreBackup(options:{backupRoot:string;destination:string}):Promise<BackupManifest>{
  const source=await privateRoot(options.backupRoot);const destination=await destinationPath(options.destination,source);
  const manifest=await verifyRoot(source);const stage=await mkdtemp(join(dirname(destination),'.asmr-restore-'));await chmod(stage,0o700);
  try{
    for(const file of manifest.files)await hashOrCopy(source,file.path,stage,file);
    checkInventory(manifest,inspectDatabase(join(stage,'studio.sqlite')));
    await publish(stage,destination,false);return manifest;
  }finally{await rm(stage,{recursive:true,force:true});}
}
