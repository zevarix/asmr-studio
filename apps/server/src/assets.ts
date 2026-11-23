import { constants, createReadStream, closeSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { parseAssetImportMetadata, parseAssetRecord, type AssetImportMetadata, type AssetRecord } from '@asmr-studio/contracts';
import type { AssetRepository } from './store.js';
import { NotFound, StudioError } from './errors.js';
import { probeAudio } from './probe.js';
export interface ByteRange { start:number; endInclusive:number }
export interface AssetContent { stream:Readable; contentType:string; totalBytes:number; range:ByteRange|null }
export interface AssetStoreOptions { root:string; repository:AssetRepository; maxUploadBytes:number; decodedBudgetBytes:number; acceptedFormats:readonly string[] }

export class AssetStore {
  private readonly root: string;
  constructor(private readonly options: AssetStoreOptions) {
    for (const value of [options.maxUploadBytes, options.decodedBudgetBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Audio budgets must be positive safe integers');
    }
    if (options.acceptedFormats.length === 0) throw new Error('At least one accepted audio format is required');
    this.root = resolve(options.root);
    for (const child of ['tmp','blobs']) mkdirSync(join(this.root,child),{recursive:true,mode:0o700});
  }
  get(id:string):AssetRecord|null { return this.options.repository.get(id); }
  list():AssetRecord[] { return this.options.repository.list(); }
  byteLength(id:string):number {
    const storage = this.options.repository.storage(id);
    if (!storage) throw new NotFound();
    return storage.bytes;
  }
  async ingest(input:AsyncIterable<Uint8Array>, metadata:AssetImportMetadata, declaredContentType='application/octet-stream'):Promise<AssetRecord> {
    const declaration = parseAssetImportMetadata(metadata);
    if (declaration.rights.privateUse !== 'permitted') throw new StudioError('RIGHTS_REQUIRED','Declare permission for private use before importing',422);
    const temporary = join(this.root,'tmp',`${randomUUID()}.part`);
    let handle:FileHandle|undefined;
    try {
      handle = await open(temporary,'wx',0o600);
      const hash = createHash('sha256'); let totalBytes = 0;
      for await (const chunk of input) {
        if (!(chunk instanceof Uint8Array)) throw new StudioError('INVALID_UPLOAD','Upload chunks must be bytes',400);
        totalBytes += chunk.byteLength;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > this.options.maxUploadBytes) throw new StudioError('UPLOAD_TOO_LARGE','Upload exceeds the configured byte budget',413);
        await handle.writeFile(chunk); hash.update(chunk);
      }
      await handle.sync(); await handle.close(); handle = undefined;
      if (totalBytes === 0) throw new StudioError('INVALID_AUDIO','The uploaded file is empty',422);
      const measured = await probeAudio(temporary,this.options.acceptedFormats,declaredContentType);
      const decodedBytes = Math.ceil(measured.durationSeconds * measured.sampleRate) * measured.channels * 4;
      if (!Number.isSafeInteger(decodedBytes) || decodedBytes > this.options.decodedBudgetBytes) {
        throw new StudioError('DECODED_BUDGET_EXCEEDED','Audio exceeds the configured decoded-memory budget',413);
      }
      const sha256 = hash.digest('hex');
      const destination = join(this.root,'blobs',`${sha256}.${measured.extension}`);
      try { await link(temporary,destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Existing content is not trusted merely because its name looks like a digest.
        const existing = await open(destination,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await existing.stat();
          if (!stat.isFile() || stat.size !== totalBytes) throw new StudioError('BLOB_CONFLICT','Existing managed audio failed integrity checks',409);
          const existingHash = createHash('sha256');
          for await (const chunk of existing.createReadStream({autoClose:false})) existingHash.update(chunk);
          if (existingHash.digest('hex') !== sha256) throw new StudioError('BLOB_CONFLICT','Existing managed audio failed integrity checks',409);
        } finally { await existing.close(); }
      }
      const {mime,extension,...audio} = measured;
      const record = parseAssetRecord({...declaration,...audio,id:randomUUID(),sha256});
      this.options.repository.insert(record,{bytes:totalBytes,mime,extension});
      return record;
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
  openContent(id:string,range?:ByteRange):AssetContent {
    const asset = this.get(id); const storage = this.options.repository.storage(id);
    if (!asset || !storage) throw new NotFound();
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.endInclusive) || range.start < 0 || range.endInclusive < range.start || range.endInclusive >= storage.bytes)) {
      throw new StudioError('INVALID_RANGE','Requested byte range is not available',416);
    }
    const path = join(this.root,'blobs',`${asset.sha256}.${storage.extension}`);
    let fd:number;
    try { fd = openSync(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch { throw new StudioError('MEDIA_UNAVAILABLE','The audio content is unavailable',410); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== storage.bytes) throw new StudioError('MEDIA_UNAVAILABLE','The audio content failed size checks',410);
      const stream = createReadStream(path,{fd,autoClose:true,...(range ? {start:range.start,end:range.endInclusive} : {})});
      return {stream,contentType:storage.mime,totalBytes:stat.size,range:range ?? null};
    } catch (error) { closeSync(fd); throw error; }
  }
}
