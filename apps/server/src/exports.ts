import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  EXPORT_SAMPLE_RATE, exportIdSchema, sceneAssetIds, listeningFadeError, parseAssetRecord, parseExportJob, parseExportRecipe, parseExportRequest,
  parseExportResult, parseWith, type AssetRecord, type ExportJob, type ExportRecipe,
  type ExportRequest, type ExportResult,
} from '@asmr-studio/contracts';
import type { AssetStore } from './assets.js';
import type { SceneStore } from './store.js';
import { MissingAsset, NotFound, RevisionConflict, StudioError } from './errors.js';
import { renderWav } from './export-renderer.js';

export interface ExportRenderOptions {
  scene: ExportRecipe['scene'];
  assets: Array<{record: AssetRecord; path: string}>;
  workDirectory: string;
  outputPath: string;
  durationSeconds: number;
  signal: AbortSignal;
  onProgress(progress: number): void;
  decodedBudgetBytes?: number;
}
export type ExportRenderer = (options: ExportRenderOptions) => Promise<ExportResult>;
export interface ExportJobsOptions {
  root: string;
  scenes: SceneStore;
  assets: AssetStore;
  renderer?: ExportRenderer;
  decodedBudgetBytes?: number;
}
interface StoredExport { schemaVersion: 1; request: ExportRequest; recipe: ExportRecipe; job: ExportJob }
interface ActiveExport { id: string; controller: AbortController; completion: Promise<void> }
export interface ExportContent { stream: Readable; bytes: number; filename: string }

const noFollow = constants.O_NOFOLLOW ?? 0;
const interruptedMessage = 'Export was interrupted before completion. Start a new export to retry.';
const failedMessage = 'Export could not be completed. Check that the source audio and local audio tools are available, then start a new export.';
const terminal = new Set<ExportJob['status']>(['complete', 'cancelled', 'failed', 'interrupted']);

function syncDirectory(path: string): void {
  // Node's Windows directory handles cannot be fsynced (EPERM). Regular files
  // are still flushed before atomic replacement; directory flushes remain on POSIX.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Flush before replacement, then flush the directory on POSIX. No partial JSON is published. */
function writeAtomic(directory: string, document: StoredExport): void {
  const temporary = join(directory, `.job-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    writeFileSync(fd, `${JSON.stringify(document)}\n`, 'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, join(directory, 'job.json'));
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function sameRequest(a: ExportRequest, b: ExportRequest): boolean {
  return a.requestId === b.requestId && a.sceneId === b.sceneId
    && a.expectedRevision === b.expectedRevision && a.durationSeconds === b.durationSeconds;
}

function readStored(directory: string, id: string): StoredExport {
  const fd = openSync(join(directory, 'job.json'), constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  let value: unknown;
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Export metadata must be a regular file');
    value = JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
    || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('request' in value)
    || !('recipe' in value) || !('job' in value)) throw new Error('Invalid export metadata');
  const request = parseExportRequest(value.request);
  const recipe = parseExportRecipe(value.recipe);
  const job = parseExportJob(value.job);
  if (request.requestId !== id || recipe.id !== id || job.id !== id
    || request.sceneId !== recipe.scene.id || request.sceneId !== job.sceneId
    || request.expectedRevision !== recipe.scene.revision || request.expectedRevision !== job.sceneRevision
    || request.durationSeconds !== recipe.durationSeconds || request.durationSeconds !== job.durationSeconds
    || recipe.createdAt !== job.createdAt || recipe.scene.title !== job.title) throw new Error('Inconsistent export metadata');
  return {schemaVersion: 1, request, recipe, job};
}

function removeUnfinishedSync(directory: string): void {
  // These names belong exclusively to this job; never inspect or remove user source paths.
  rmSync(join(directory, 'work'), {recursive: true, force: true});
  for (const name of ['output.part.wav', 'output.wav']) {
    try { unlinkSync(join(directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Durable, single-worker exports. A restart records interruption rather than silently repeating work. */
export class ExportJobs {
  private readonly root: string;
  private readonly records = new Map<string, StoredExport>();
  private readonly pending: string[] = [];
  private readonly renderer: ExportRenderer;
  private active: ActiveExport | null = null;
  private worker: Promise<void> | null = null;
  private scheduled = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ExportJobsOptions) {
    if (options.decodedBudgetBytes !== undefined && (!Number.isSafeInteger(options.decodedBudgetBytes) || options.decodedBudgetBytes <= 0)) {
      throw new Error('Export decoded-memory budget must be a positive safe integer');
    }
    this.root = resolve(options.root);
    this.renderer = options.renderer ?? renderWav;
    mkdirSync(this.root, {recursive: true, mode: 0o700});
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Export storage must be a private directory');
    for (const entry of readdirSync(this.root, {withFileTypes: true})) {
      if (!entry.isDirectory() || !exportIdSchema.safeParse(entry.name).success) continue;
      const directory = this.directory(entry.name);
      let stored: StoredExport;
      try { stored = readStored(directory, entry.name); }
      catch { continue; } // Unrecognized/corrupt files are preserved, never treated as jobs or recursively removed.
      if (stored.job.status === 'queued' || stored.job.status === 'rendering') {
        stored.job = parseExportJob({...stored.job, status: 'interrupted', error: interruptedMessage,
          result: null, updatedAt: new Date().toISOString()});
        writeAtomic(directory, stored);
      }
      if (stored.job.status !== 'complete') removeUnfinishedSync(directory);
      else rmSync(join(directory, 'work'), {recursive: true, force: true});
      this.records.set(stored.job.id, stored);
    }
  }

  list(): ExportJob[] {
    return [...this.records.values()].map(stored => structuredClone(stored.job))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  get(id: string): ExportJob { return structuredClone(this.lookup(id).job); }
  recipe(id: string): ExportRecipe { return structuredClone(this.lookup(id).recipe); }

  async create(input: unknown): Promise<ExportJob> {
    const request = parseExportRequest(input);
    const previous = this.records.get(request.requestId);
    if (previous) return this.existing(previous, request);
    if (this.closing) throw new StudioError('EXPORTS_CLOSING', 'The studio is closing. Reopen it before starting an export.', 503);
    const scene = this.options.scenes.get(request.sceneId);
    if (!scene) throw new NotFound();
    if (scene.revision !== request.expectedRevision) throw new RevisionConflict(scene.revision);
    if (scene.transition && (!scene.transition.a || !scene.transition.b)) {
      throw new StudioError('TRANSITION_INCOMPLETE', 'Choose both saved mixes before exporting this transition.', 422);
    }
    const fadeError = listeningFadeError(scene.listeningTimer, Math.round(request.durationSeconds * EXPORT_SAMPLE_RATE) / EXPORT_SAMPLE_RATE);
    if (fadeError) throw new StudioError('EXPORT_FADE_INVALID', fadeError, 422);
    const captured = scene.transition ? new Map([...(scene.transition.a?.assets ?? []), ...(scene.transition.b?.assets ?? [])].map(asset => [asset.id, asset])) : null;
    const assets = sceneAssetIds(scene).map(id => {
      const current = this.options.assets.get(id);
      const asset = captured ? captured.get(id) : current;
      if (!asset || !current) throw new MissingAsset();
      if (asset.rights.privateUse !== 'permitted' || current.rights.privateUse !== 'permitted') throw new StudioError('RIGHTS_REQUIRED', 'Permission for private use is required for every export source', 422);
      if (captured && JSON.stringify(parseAssetRecord(current)) !== JSON.stringify(parseAssetRecord(asset))) {
        throw new StudioError('EXPORT_SOURCE_CHANGED', 'A captured recording no longer matches its accepted source declaration.', 422);
      }
      return parseAssetRecord(asset);
    });
    const createdAt = new Date().toISOString();
    const job = parseExportJob({id: request.requestId, sceneId: scene.id, sceneRevision: scene.revision,
      title: scene.title, createdAt, updatedAt: createdAt, durationSeconds: request.durationSeconds,
      status: 'queued', progress: 0, error: null, result: null});
    const recipe = parseExportRecipe({schemaVersion: 1, id: job.id, createdAt,
      durationSeconds: request.durationSeconds, scene, assets});
    const stored: StoredExport = {schemaVersion: 1, request, recipe, job};
    const directory = this.directory(job.id);
    try { mkdirSync(directory, {mode: 0o700}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A previous metadata write may have succeeded before its caller saw an I/O failure.
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StudioError('EXPORT_STORAGE_CONFLICT', 'The export identity is unavailable in local storage', 409);
      let recovered: StoredExport;
      try { recovered = readStored(directory, job.id); }
      catch { throw new StudioError('EXPORT_STORAGE_CONFLICT', 'The export identity is unavailable in local storage', 409); }
      if (!terminal.has(recovered.job.status)) {
        recovered.job = parseExportJob({...recovered.job, status: 'interrupted', error: interruptedMessage, updatedAt: createdAt});
        writeAtomic(directory, recovered);
      }
      this.records.set(job.id, recovered);
      return this.existing(recovered, request);
    }
    writeAtomic(directory, stored);
    syncDirectory(this.root);
    this.records.set(job.id, stored);
    this.pending.push(job.id);
    this.schedule();
    return structuredClone(job);
  }

  async cancel(id: string): Promise<ExportJob> {
    const stored = this.lookup(id);
    if (terminal.has(stored.job.status)) return structuredClone(stored.job);
    const active = this.active;
    if (active?.id === id) {
      active.controller.abort('cancel');
      await active.completion;
    } else {
      const index = this.pending.indexOf(id);
      if (index !== -1) this.pending.splice(index, 1);
      this.commit(stored, {status: 'cancelled', result: null, error: null});
    }
    return structuredClone(stored.job);
  }

  async openContent(id: string): Promise<ExportContent> {
    const stored = this.lookup(id);
    if (stored.job.status !== 'complete' || !stored.job.result) {
      throw new StudioError('EXPORT_NOT_COMPLETE', 'This export has no completed WAV available', 409);
    }
    let handle: FileHandle | undefined;
    try {
      handle = await this.verifyFile(join(this.directory(id), 'output.wav'), stored.job.result);
      const stream = handle.createReadStream({start: 0, autoClose: true});
      return {stream, bytes: stored.job.result.bytes, filename: `asmr-${id}.wav`};
    } catch {
      await handle?.close();
      throw new StudioError('EXPORT_UNAVAILABLE', 'The finished WAV is unavailable or failed its saved integrity check', 410);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClosing();
    return this.closePromise;
  }

  private async finishClosing(): Promise<void> {
    let persistenceError: unknown;
    for (const id of this.pending.splice(0)) {
      const stored = this.records.get(id);
      if (stored?.job.status === 'queued') {
        try { this.commit(stored, {status: 'interrupted', error: interruptedMessage, result: null}); }
        catch (error) { persistenceError = error; }
      }
    }
    if (this.active && !this.active.controller.signal.aborted) this.active.controller.abort('shutdown');
    await this.worker;
    if (persistenceError) throw persistenceError;
  }

  private directory(id: string): string { return join(this.root, id); }

  private lookup(id: string): StoredExport {
    const validated = parseWith(exportIdSchema, id);
    const stored = this.records.get(validated);
    if (!stored) throw new NotFound();
    return stored;
  }

  private existing(stored: StoredExport, request: ExportRequest): ExportJob {
    if (!sameRequest(stored.request, request)) {
      throw new StudioError('EXPORT_REQUEST_CONFLICT', 'This export request ID was already used with different settings', 409);
    }
    return structuredClone(stored.job);
  }

  private commit(stored: StoredExport, changes: Partial<ExportJob>): void {
    const job = parseExportJob({...stored.job, ...changes, updatedAt: new Date().toISOString()});
    writeAtomic(this.directory(job.id), {...stored, job});
    stored.job = job;
  }

  private schedule(): void {
    if (this.closing || this.worker || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closing || this.worker) return;
      this.worker = this.drain().finally(() => {
        this.worker = null;
        if (this.pending.length) this.schedule();
      });
    });
  }

  private async drain(): Promise<void> {
    while (!this.closing && this.pending.length) {
      const id = this.pending.shift()!;
      const stored = this.records.get(id);
      if (!stored || stored.job.status !== 'queued') continue;
      const active: ActiveExport = {id, controller: new AbortController(), completion: Promise.resolve()};
      this.active = active;
      active.completion = this.execute(stored, active.controller.signal);
      await active.completion;
      this.active = null;
    }
  }

  private async execute(stored: StoredExport, signal: AbortSignal): Promise<void> {
    const directory = this.directory(stored.job.id);
    const workDirectory = join(directory, 'work');
    const outputPath = join(directory, 'output.part.wav');
    try {
      this.commit(stored, {status: 'rendering', progress: 0});
      await mkdir(workDirectory, {mode: 0o700});
      const assets: ExportRenderOptions['assets'] = [];
      for (const [index, record] of stored.recipe.assets.entries()) {
        signal.throwIfAborted();
        const path = join(workDirectory, `source-${index}.audio`);
        await this.copySource(record, path, signal);
        assets.push({record: structuredClone(record), path});
      }
      signal.throwIfAborted();
      const result = parseExportResult(await this.renderer({scene: structuredClone(stored.recipe.scene), assets,
        workDirectory, outputPath, durationSeconds: stored.request.durationSeconds, signal,
        ...(this.options.decodedBudgetBytes === undefined ? {} : {decodedBudgetBytes: this.options.decodedBudgetBytes}),
        onProgress: progress => {
          const next = Math.min(0.999, progress);
          if (Number.isFinite(next) && next >= stored.job.progress + 0.01 && !signal.aborted) this.commit(stored, {progress: next});
        }}));
      signal.throwIfAborted();
      if (Math.abs(result.durationSeconds - stored.request.durationSeconds) > 1 / 48_000) throw new Error('Export duration mismatch');
      const output = await this.verifyFile(outputPath, result, true, signal);
      try { await output.sync(); } finally { await output.close(); }
      signal.throwIfAborted();
      await rename(outputPath, join(directory, 'output.wav'));
      syncDirectory(directory);
      signal.throwIfAborted();
      this.commit(stored, {status: 'complete', progress: 1, error: null, result});
    } catch (cause) {
      for (const name of ['output.part.wav', 'output.wav']) await unlink(join(directory, name)).catch(() => undefined);
      const status = signal.aborted ? (signal.reason === 'shutdown' ? 'interrupted' : 'cancelled') : 'failed';
      const safeFailure = cause instanceof StudioError && ['EXPORT_BUDGET_EXCEEDED','EXPORT_STORAGE_BUDGET'].includes(cause.code) ? cause.message : failedMessage;
      const error = status === 'failed' ? safeFailure : status === 'interrupted' ? interruptedMessage : null;
      try { this.commit(stored, {status, error, result: null}); }
      catch {
        // A storage failure must still never advertise a finished WAV. Recovery sees the last durable state.
        stored.job = parseExportJob({...stored.job, status, error, result: null, updatedAt: new Date().toISOString()});
      }
    } finally {
      await rm(workDirectory, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  private async copySource(record: AssetRecord, path: string, signal: AbortSignal): Promise<void> {
    const content = this.options.assets.openContent(record.id);
    const stop = () => { content.stream.destroy(); };
    signal.addEventListener('abort', stop, {once: true});
    let handle: FileHandle | undefined;
    try {
      signal.throwIfAborted();
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of content.stream) {
        signal.throwIfAborted();
        await handle.writeFile(chunk);
        hash.update(chunk); bytes += chunk.length;
      }
      if (bytes !== content.totalBytes || hash.digest('hex') !== record.sha256) throw new Error('Export source integrity mismatch');
      await handle.sync();
    } finally {
      signal.removeEventListener('abort', stop);
      content.stream.destroy();
      await handle?.close();
    }
  }

  private async verifyFile(path: string, result: ExportResult, writable = false, signal?: AbortSignal): Promise<FileHandle> {
    signal?.throwIfAborted();
    const handle = await open(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== result.bytes) throw new Error('Export size mismatch');
      const header = Buffer.alloc(12);
      await handle.read(header, 0, 12, 0);
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Export is not a RIFF WAV');
      const hash = createHash('sha256');
      const stream = handle.createReadStream({start: 0, autoClose: false});
      const stop = () => { stream.destroy(); };
      signal?.addEventListener('abort', stop, {once: true});
      try {
        signal?.throwIfAborted();
        for await (const chunk of stream) hash.update(chunk);
        signal?.throwIfAborted();
      } finally { signal?.removeEventListener('abort', stop); }
      if (hash.digest('hex') !== result.sha256) throw new Error('Export digest mismatch');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
}
