import { constants, lstatSync, mkdirSync } from 'node:fs';
import { chmod, link, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loopSchema, type AssetImportMetadata, type AssetRecord } from '@asmr-studio/contracts';
import { AssetStore } from './assets.js';
import { StudioError } from './errors.js';
import { starterCatalog, type StarterSound } from './starter-catalog.js';

const runFile = promisify(execFile);
const transferTimeoutMs = 60_000;
type PrepareSound = (sourcePath:string, destinationPath:string, sound:StarterSound)=>Promise<void>;
export interface StarterLibraryOptions {
  root:string;
  assets:AssetStore;
  catalog?:readonly StarterSound[];
  fetch?:typeof globalThis.fetch;
  prepare?:PrepareSound;
}
export type StarterCatalogEntry = StarterSound & {assetId:string|null;modifications:string};

function modification(sound:StarterSound):string {
  if (sound.preparation==='preserve-wav') {
    return `Prepared loop: ${sound.durationSeconds} seconds; 44.1 kHz, 16-bit PCM WAV with ${sound.channels===1?'mono':'stereo'} channels, installed byte-for-byte. ${sound.preparationNotes ?? ''} No additional gain, resampling, normalization or fades are applied during installation.`;
  }
  const gain = sound.gainDb ? `Fixed playback gain: ${sound.gainDb>0?'+':''}${sound.gainDb} dB. ` : '';
  return `ASMR Studio excerpt: ${sound.excerpt.startSeconds}–${sound.excerpt.startSeconds+sound.excerpt.durationSeconds} seconds; converted to 44.1 kHz, 16-bit PCM WAV with ${sound.channels===1?'mono':'stereo'} channels preserved. ${gain}No loudness normalization.`;
}
function metadata(sound:StarterSound):AssetImportMetadata {
  return {
    displayName:sound.title,
    roles:[sound.category==='ambience'?'ambience':'texture'],
    provenance:{kind:'licensed',source:`${sound.attribution} ${modification(sound)} Source: ${sound.sourceForm}. Download: ${sound.downloadUrl}. Source SHA-256: ${sound.sha256}.`},
    rights:{privateUse:'permitted',redistribution:'permitted'},
  };
}
function validateCatalog(sounds:readonly StarterSound[]):void {
  const ids = new Set<string>();
  for (const sound of sounds) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sound.id) || ids.has(sound.id) || !/^[a-z0-9][a-z0-9._-]*$/i.test(sound.filename)) throw new Error('Invalid starter sound identity');
    ids.add(sound.id);
    const url = new URL(sound.downloadUrl);
    if (url.protocol!=='https:' || url.username || url.password || url.hash) throw new Error('Starter sources require fixed HTTPS URLs');
    if (!Number.isSafeInteger(sound.bytes) || sound.bytes<=0 || !/^[a-f0-9]{64}$/.test(sound.sha256)) throw new Error('Starter sources require exact bytes and SHA-256');
    if (![1,2].includes(sound.channels) || !Number.isFinite(sound.excerpt.startSeconds) || sound.excerpt.startSeconds<0 || !Number.isFinite(sound.excerpt.durationSeconds) || sound.excerpt.durationSeconds<=0 || sound.excerpt.startSeconds+sound.excerpt.durationSeconds>sound.durationSeconds) throw new Error('Invalid starter sound excerpt');
    if (sound.gainDb!==undefined && (!Number.isFinite(sound.gainDb) || sound.gainDb < -60 || sound.gainDb > 60)) throw new Error('Starter playback gain must be finite and between -60 and 60 dB');
    if (sound.preferredLoop!==undefined && (!loopSchema.safeParse(sound.preferredLoop).success || sound.preferredLoop.endSeconds>sound.excerpt.durationSeconds)) throw new Error('Invalid starter preferred loop');
    if (sound.preparation!==undefined) {
      const frames=sound.durationSeconds*44100;
      if (sound.preparation!=='preserve-wav' || sound.sampleRate!==44100 || !sound.filename.endsWith('.wav') ||
        sound.gainDb!==undefined || sound.archiveMember!==undefined || sound.excerpt.startSeconds!==0 || sound.excerpt.durationSeconds!==sound.durationSeconds ||
        !Number.isSafeInteger(frames) || frames<=0 || sound.bytes!==44+frames*sound.channels*2) throw new Error('Prepared starter sounds require a complete 44.1 kHz PCM16 WAV without further processing');
    }
    if (sound.archiveMember!==undefined) {
      if (!sound.archiveMember || sound.archiveMember.startsWith('-') || /[\\\0*?\[\]]/.test(sound.archiveMember) || sound.archiveMember.split('/').some(part=>part==='' || part==='.' || part==='..') || !Number.isSafeInteger(sound.archiveBytes) || sound.archiveBytes!<=0 || !/^[a-f0-9]{64}$/.test(sound.archiveSha256 ?? '')) throw new Error('Invalid starter archive member');
    } else if (sound.archiveBytes!==undefined || sound.archiveSha256!==undefined) throw new Error('Archive metadata needs an exact member');
  }
}
async function verifiedFile(path:string,bytes:number,digest:string):Promise<boolean> {
  let file:FileHandle;
  try { file = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;
    throw new StudioError('STARTER_CACHE_CONFLICT','An existing starter cache path could not be verified',409);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size!==bytes) throw new StudioError('STARTER_CACHE_CONFLICT','An existing starter file failed its size check',409);
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({autoClose:false})) hash.update(chunk);
    if (hash.digest('hex')!==digest) throw new StudioError('STARTER_CACHE_CONFLICT','An existing starter file failed its integrity check',409);
    return true;
  } finally { await file.close(); }
}
async function commitFile(temporary:string,destination:string,bytes:number,digest:string):Promise<void> {
  try { await link(temporary,destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
    if (!await verifiedFile(destination,bytes,digest)) throw new StudioError('STARTER_CACHE_CONFLICT','The starter cache changed during installation',409);
  }
}
async function prepareRecording(sourcePath:string,destinationPath:string,sound:StarterSound):Promise<void> {
  try {
    await runFile('ffmpeg',[
      '-nostdin','-hide_banner','-loglevel','error','-n','-protocol_whitelist','file,pipe','-i',sourcePath,
      '-ss',String(sound.excerpt.startSeconds),'-t',String(sound.excerpt.durationSeconds),'-map','0:a:0','-vn',
      ...(sound.gainDb ? ['-af',`volume=${sound.gainDb}dB`] : []),
      '-ac',String(sound.channels),'-ar','44100','-c:a','pcm_s16le','-map_metadata','-1','-fflags','+bitexact',destinationPath,
    ],{timeout:transferTimeoutMs,maxBuffer:1024*1024});
    await chmod(destinationPath,0o600);
  } catch {
    throw new StudioError('STARTER_PREPARATION_FAILED',`Could not prepare ${sound.title}; check that ffmpeg is installed`,422);
  }
}

function allowsReleaseRedirect(sound:StarterSound):boolean {
  // GitHub serves these fixed release assets through its signed asset CDN. No
  // caller-supplied URL or other catalog source gains redirect permission.
  return sound.preparation==='preserve-wav' && ['window-rain.wav','rain-on-wood.wav','small-brook.wav'].some(filename=>
    sound.downloadUrl===`https://github.com/zevarix/asmr-studio/releases/download/sounds-earshot-water-v1/${filename}`);
}
async function verifyPreparedWav(file:FileHandle,sound:StarterSound):Promise<void> {
  // The prepared release has canonical 44-byte PCM headers. Keeping this narrow
  // also prevents a future catalog edit from silently changing its format.
  const header=Buffer.alloc(44);
  const {bytesRead}=await file.read(header,0,header.length,0);
  const stat=await file.stat();
  if (bytesRead!==44 || stat.size!==sound.bytes || header.toString('ascii',0,4)!=='RIFF' || header.readUInt32LE(4)!==sound.bytes-8 ||
    header.toString('ascii',8,16)!=='WAVEfmt ' || header.readUInt32LE(16)!==16 || header.readUInt16LE(20)!==1 ||
    header.readUInt16LE(22)!==sound.channels || header.readUInt32LE(24)!==44100 || header.readUInt32LE(28)!==44100*sound.channels*2 ||
    header.readUInt16LE(32)!==sound.channels*2 || header.readUInt16LE(34)!==16 || header.toString('ascii',36,40)!=='data' ||
    header.readUInt32LE(40)!==sound.bytes-44) throw new StudioError('STARTER_PREPARATION_FAILED','The prepared starter is not the expected complete PCM16 WAV',422);
}

/** Installs only the repository's fixed catalog. HTTP callers cannot supply URLs or preparation arguments. */
export class StarterLibrary {
  private readonly base:string;
  private readonly originals:string;
  private readonly attributions:string;
  private readonly temporary:string;
  private readonly sounds:readonly StarterSound[];
  private readonly fetchSource:typeof globalThis.fetch;
  private readonly prepare:PrepareSound;
  private pending:Promise<AssetRecord[]>|null = null;

  constructor(private readonly options:StarterLibraryOptions) {
    this.sounds = structuredClone(options.catalog ?? starterCatalog);
    validateCatalog(this.sounds);
    this.fetchSource = options.fetch ?? globalThis.fetch;
    this.prepare = options.prepare ?? prepareRecording;
    this.base = join(resolve(options.root),'starters');
    this.originals = join(this.base,'originals');
    this.attributions = join(this.base,'attribution');
    this.temporary = join(this.base,'tmp');
    for (const path of [this.base,this.originals,this.attributions,this.temporary]) {
      mkdirSync(path,{recursive:true,mode:0o700});
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Starter storage must use real directories');
    }
  }

  private installed(sound:StarterSound):AssetRecord|null {
    const expected = metadata(sound);
    if (sound.preparation==='preserve-wav') {
      // Reuse a byte-identical licensed import without changing its identity,
      // user-facing name, provenance, or any saved layers that reference it.
      return this.options.assets.list().find(asset=>asset.sha256===sound.sha256 && asset.format==='wav' &&
        asset.sampleRate===sound.sampleRate && asset.channels===sound.channels && asset.durationSeconds===sound.durationSeconds &&
        asset.provenance.kind==='licensed' && asset.provenance.source!==null &&
        asset.rights.privateUse==='permitted' && asset.rights.redistribution==='permitted' &&
        asset.roles.length===1 && asset.roles[0]===expected.roles[0] && this.options.assets.byteLength(asset.id)===sound.bytes) ?? null;
    }
    return this.options.assets.list().find(asset=>asset.displayName===expected.displayName && asset.provenance.kind==='licensed' && asset.provenance.source===expected.provenance.source && asset.rights.privateUse==='permitted' && asset.rights.redistribution==='permitted' && asset.roles.length===1 && asset.roles[0]===expected.roles[0]) ?? null;
  }
  catalog():StarterCatalogEntry[] {
    return this.sounds.map(sound=>({...structuredClone(sound),assetId:this.installed(sound)?.id ?? null,modifications:modification(sound)}));
  }
  install():Promise<AssetRecord[]> {
    if (this.pending) return this.pending;
    const promise = this.installCatalog().finally(()=>{if(this.pending===promise)this.pending=null;});
    this.pending = promise;
    return promise;
  }
  private async storeBytes(destination:string,data:Uint8Array,expectedBytes:number,expectedHash:string):Promise<void> {
    if (data.byteLength!==expectedBytes || createHash('sha256').update(data).digest('hex')!==expectedHash) throw new StudioError('STARTER_SOURCE_INTEGRITY','The starter source failed its integrity check',502);
    if (await verifiedFile(destination,expectedBytes,expectedHash)) return;
    const temporary = join(this.temporary,`${randomUUID()}.part`);
    let file:FileHandle|undefined;
    try {
      file = await open(temporary,'wx',0o600);await file.writeFile(data);await file.sync();await file.close();file=undefined;
      await commitFile(temporary,destination,expectedBytes,expectedHash);
    } finally { await file?.close();await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}); }
  }
  private async download(sound:StarterSound,destination:string,expectedBytes:number,expectedHash:string):Promise<void> {
    if (await verifiedFile(destination,expectedBytes,expectedHash)) return;
    const temporary = join(this.temporary,`${randomUUID()}.part`);
    let file:FileHandle|undefined;
    try {
      const signal=AbortSignal.timeout(transferTimeoutMs);
      const redirectAllowed=allowsReleaseRedirect(sound);
      let response = await this.fetchSource(sound.downloadUrl,{redirect:redirectAllowed?'manual':'error',signal});
      if (redirectAllowed && [301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get('location');
        await response.body?.cancel().catch(()=>{});
        let target:URL|null=null;
        try { if(location)target=new URL(location); } catch { /* Rejected below. */ }
        if (!target || !location?.startsWith('https://release-assets.githubusercontent.com/') || target.origin!=='https://release-assets.githubusercontent.com' ||
          target.username || target.password || target.hash || target.port) throw new StudioError('STARTER_DOWNLOAD_FAILED','The starter release redirect was not an approved asset host',502);
        response=await this.fetchSource(target.href,{redirect:'error',signal});
      }
      if (response.status!==200 || !response.body) {
        await response.body?.cancel().catch(()=>{});
        throw new StudioError('STARTER_DOWNLOAD_FAILED',`Could not download ${sound.title}`,502);
      }
      const declared = response.headers.get('content-length');
      if (declared!==null && Number(declared)!==expectedBytes) {
        await response.body.cancel().catch(()=>{});
        throw new StudioError('STARTER_SOURCE_INTEGRITY',`${sound.title} has an unexpected source size`,502);
      }
      file = await open(temporary,'wx',0o600);
      const hash = createHash('sha256');let total = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const part = await reader.read();if(part.done)break;
          total += part.value.byteLength;
          if (!Number.isSafeInteger(total) || total>expectedBytes) throw new StudioError('STARTER_SOURCE_INTEGRITY',`${sound.title} exceeds its expected source size`,502);
          await file.writeFile(part.value);hash.update(part.value);
        }
      } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
      if (total!==expectedBytes || hash.digest('hex')!==expectedHash) throw new StudioError('STARTER_SOURCE_INTEGRITY',`${sound.title} failed its source integrity check`,502);
      await file.sync();await file.close();file=undefined;
      await commitFile(temporary,destination,expectedBytes,expectedHash);
    } finally { await file?.close();await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}); }
  }
  private async original(sound:StarterSound):Promise<string> {
    const destination = join(this.originals,sound.filename);
    if (await verifiedFile(destination,sound.bytes,sound.sha256)) return destination;
    if (sound.archiveMember!==undefined) {
      const archive = join(this.originals,`${sound.id}-source-pack.zip`);
      await this.download(sound,archive,sound.archiveBytes!,sound.archiveSha256!);
      let content:Buffer;
      try {
        const result = await runFile('unzip',['-p',archive,sound.archiveMember],{encoding:'buffer',maxBuffer:sound.bytes,timeout:transferTimeoutMs});
        content = result.stdout;
      } catch { throw new StudioError('STARTER_EXTRACTION_FAILED',`Could not read the selected recording from ${sound.title}; check that unzip is installed`,422); }
      await this.storeBytes(destination,content,sound.bytes,sound.sha256);
    } else await this.download(sound,destination,sound.bytes,sound.sha256);
    return destination;
  }
  private async installCatalog():Promise<AssetRecord[]> {
    const attribution = Buffer.from(JSON.stringify({schemaVersion:1,sounds:this.sounds.map(sound=>({...sound,modifications:modification(sound)}))},null,2)+'\n');
    const attributionHash = createHash('sha256').update(attribution).digest('hex');
    // Catalog additions get a new immutable snapshot; legacy attribution.json stays untouched.
    await this.storeBytes(join(this.attributions,`${attributionHash}.json`),attribution,attribution.byteLength,attributionHash);
    const result:AssetRecord[] = [];
    for (const sound of this.sounds) {
      const existing = this.installed(sound);
      if (existing) {result.push(existing);continue;}
      const source = await this.original(sound);
      const preserved=sound.preparation==='preserve-wav';
      const playback = preserved?source:join(this.temporary,`${randomUUID()}.wav`);
      let file:FileHandle|undefined;
      try {
        if (!preserved) await this.prepare(source,playback,sound);
        file = await open(playback,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await file.stat();
        const maximumBytes = Math.ceil(sound.excerpt.durationSeconds*44100)*sound.channels*2+65536;
        if (!stat.isFile() || stat.size>maximumBytes) throw new StudioError('STARTER_PREPARATION_FAILED','The prepared recording exceeded its expected size',422);
        if (preserved) await verifyPreparedWav(file,sound);
        result.push(await this.options.assets.ingest(file.createReadStream({autoClose:false}),metadata(sound),'audio/wav'));
      } finally { await file?.close();if(!preserved)await unlink(playback).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}); }
    }
    return result;
  }
}
