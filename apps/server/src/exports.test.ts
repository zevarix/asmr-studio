import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyScene, createEmptyTransition, MAX_EXPORT_SECONDS, parseAssetRecord, type ExportRequest, type ExportResult } from '@asmr-studio/contracts';
import { fixtureAsset, fixtureLayer } from '../../../tests/fixtures/scene.js';
import { wavFixture } from '../../../tests/fixtures/audio.js';
import { AssetStore } from './assets.js';
import { buildApp } from './app.js';
import { ExportJobs, type ExportRenderer, type ExportRenderOptions } from './exports.js';
import { StudioError } from './errors.js';
import { openStore } from './store.js';

const roots: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
const queues: ExportJobs[] = [];
const applications: ReturnType<typeof buildApp>[] = [];
const releases: Array<() => void> = [];
const origin = 'http://127.0.0.1:4317';
const headers = {host: '127.0.0.1:4317', origin};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return {promise, resolve};
}

async function waitForRelease(gate: ReturnType<typeof deferred>, signal: AbortSignal): Promise<void> {
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error('Cancelled test render')); });
  signal.addEventListener('abort', stop, {once: true});
  try { signal.throwIfAborted(); await Promise.race([gate.promise, aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

async function writeResult(options: ExportRenderOptions): Promise<ExportResult> {
  const frames = Math.max(1, Math.round(options.durationSeconds * 48_000));
  const wav = wavFixture({frames});
  await writeFile(options.outputPath, wav, {flag: 'wx', mode: 0o600});
  options.onProgress(0.8);
  return {bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex'), durationSeconds: frames / 48_000,
    sampleRate: 48_000, channels: 2, peak: 1200 / 32768, rms: 0.02, clippedSamples: 0};
}

function fresh(renderer: ExportRenderer = writeResult) {
  const root = mkdtempSync(join(tmpdir(), 'asmr-exports-')); roots.push(root);
  const store = openStore(join(root, 'studio.sqlite')); stores.push(store);
  const assets = new AssetStore({root: join(root, 'media'), repository: store.assets,
    maxUploadBytes: 1024 * 1024, decodedBudgetBytes: 1024 * 1024, acceptedFormats: ['wav']});
  const bytes = wavFixture();
  const asset = parseAssetRecord({...fixtureAsset(), durationSeconds: 0.1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    provenance: {kind: 'licensed', source: 'Test creator; CC BY 4.0; https://example.com/recording; excerpt applied.'}});
  const sourcePath = join(root, 'media', 'blobs', `${asset.sha256}.wav`);
  writeFileSync(sourcePath, bytes);
  store.assets.insert(asset, {bytes: bytes.length, mime: 'audio/wav', extension: 'wav'});
  const scene = store.scenes.create({...createEmptyScene('scene-1', 'Quiet room'), layers: [fixtureLayer()]});
  const jobs = new ExportJobs({root: join(root, 'exports'), scenes: store.scenes, assets, renderer}); queues.push(jobs);
  const request: ExportRequest = {requestId: randomUUID(), sceneId: scene.id, expectedRevision: scene.revision, durationSeconds: 0.1};
  return {root, store, assets, asset, bytes, sourcePath, scene, jobs, request};
}

async function completed(jobs: ExportJobs, id: string): Promise<void> {
  await vi.waitFor(() => expect(jobs.get(id).status).toBe('complete'));
}

afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await Promise.all(applications.splice(0).map(app => app.close()));
  await Promise.all(queues.splice(0).map(jobs => jobs.close()));
  stores.splice(0).forEach(store => store.close());
  roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true}));
});

describe('durable export jobs', () => {
  it('captures both transition credits and revisions independently of later edits, without deduplicating equal content declarations',async()=>{
    const gate=deferred();
    const renderer=vi.fn(async (options:ExportRenderOptions)=>{await waitForRelease(gate,options.signal);return writeResult(options);});
    const f=fresh(renderer);
    const other={...f.asset,id:'other-recording',provenance:{kind:'licensed' as const,source:'Other creator; independent attribution'}};
    f.store.assets.insert(other,{bytes:f.bytes.length,mime:'audio/wav',extension:'wav'});
    const b=f.store.scenes.create({...createEmptyScene('source-b','Source B'),layers:[{...fixtureLayer(),assetId:other.id}]});
    const aCapture=f.store.scenes.capture(f.scene.id,1),bCapture=f.store.scenes.capture(b.id,1);
    const empty=createEmptyTransition('transition','Captured blend');
    const arrangement=f.store.scenes.create({...empty,transition:{...empty.transition!,a:aCapture,b:bCapture,blend:.35}});
    const request={...f.request,sceneId:arrangement.id,expectedRevision:arrangement.revision};
    await f.jobs.create(request);await vi.waitFor(()=>expect(renderer).toHaveBeenCalledTimes(1));
    f.store.scenes.save({...f.scene,title:'A edited',masterGain:.9},1);
    f.store.scenes.save({...b,title:'B edited',layers:[]},1);
    f.store.scenes.save({...arrangement,title:'Arrangement edited'},1);
    const recipe=f.jobs.recipe(request.requestId);
    expect(recipe.scene).toEqual(arrangement);expect(recipe.assets).toEqual([f.asset,other]);
    expect(recipe.scene.transition).toMatchObject({a:aCapture,b:bCapture,blend:.35});
    expect(renderer.mock.calls[0]![0].assets.map(asset=>asset.record)).toEqual([f.asset,other]);
    recipe.scene.transition!.a!.scene.title='Caller mutation';
    expect(f.jobs.recipe(request.requestId).scene.transition?.a?.scene.title).toBe('Quiet room');
    gate.resolve();await completed(f.jobs,request.requestId);
    const content=await f.jobs.openContent(request.requestId);expect(content.bytes).toBeGreaterThan(44);
    for await(const _chunk of content.stream){/* Consume and close the verified download handle. */}
  });

  it('rejects incomplete arrangements and requires rights on the inaudible captured side before creating a job',async()=>{
    const f=fresh(),a=f.store.scenes.capture(f.scene.id,1),empty=createEmptyTransition('transition','Transition');
    const incomplete=f.store.scenes.create({...empty,transition:{...empty.transition!,a}});
    await expect(f.jobs.create({...f.request,sceneId:incomplete.id})).rejects.toMatchObject({code:'TRANSITION_INCOMPLETE'});
    const unknown={...f.asset,id:'unknown-rights',rights:{...f.asset.rights,privateUse:'unknown' as const}};
    f.store.assets.insert(unknown,{bytes:f.bytes.length,mime:'audio/wav',extension:'wav'});
    const source=f.store.scenes.create({...createEmptyScene('unknown-source','Unknown rights'),layers:[{...fixtureLayer(),assetId:unknown.id}]});
    const b=f.store.scenes.capture(source.id,1);
    const complete=f.store.scenes.save({...incomplete,transition:{...incomplete.transition!,b,blend:0}},1);
    await expect(f.jobs.create({...f.request,sceneId:complete.id,expectedRevision:2})).rejects.toMatchObject({code:'RIGHTS_REQUIRED'});
    expect(f.jobs.list()).toEqual([]);expect(readdirSync(join(f.root,'exports'))).toEqual([]);
  });

  it('validates every saved alternate and freezes separate rights and provenance records for identical bytes',async()=>{
    const renderer=vi.fn(writeResult),f=fresh(renderer);
    const alternate={...f.asset,id:'alternate',provenance:{kind:'licensed' as const,source:'Second creator declaration'}};
    const occasional={enabled:false,minPauseSeconds:4,maxPauseSeconds:12,seed:4,alternateAssetIds:[alternate.id],levelVariation:0,panVariation:0};
    const next={...f.scene,layers:[{...f.scene.layers[0]!,occasional}]};
    expect(()=>f.store.scenes.save(next,1)).toThrow('unavailable');
    const blob={bytes:f.bytes.length,mime:'audio/wav',extension:'wav'};
    f.store.assets.insert(alternate,blob);
    const saved=f.store.scenes.save(next,1);
    const request={...f.request,expectedRevision:saved.revision};
    await f.jobs.create(request);
    expect(f.jobs.recipe(request.requestId).assets).toEqual([f.asset,alternate]);
    await completed(f.jobs,request.requestId);
    expect(renderer.mock.calls[0]![0].assets.map(asset=>asset.record)).toEqual([f.asset,alternate]);
    const unknown={...alternate,id:'unsure',rights:{...alternate.rights,privateUse:'unknown' as const}};
    f.store.assets.insert(unknown,blob);
    const withUnknown=f.store.scenes.save({...saved,layers:[{...saved.layers[0]!,occasional:{...occasional,alternateAssetIds:[unknown.id]}}]},saved.revision);
    await expect(f.jobs.create({...request,requestId:randomUUID(),expectedRevision:withUnknown.revision})).rejects.toMatchObject({code:'RIGHTS_REQUIRED'});
    expect(f.jobs.list()).toHaveLength(1);
  });

  it('freezes queued scene revisions and source credits, renders private byte copies, and serializes work', async () => {
    const gate = deferred(); let running = 0; let maximum = 0;
    const calls: ExportRenderOptions[] = [];
    const renderer: ExportRenderer = async options => {
      running++; maximum = Math.max(maximum, running); calls.push(options);
      try {
        if (calls.length === 1) await waitForRelease(gate, options.signal);
        for (const source of options.assets) expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(source.record.sha256);
        return await writeResult(options);
      } finally { running--; }
    };
    const f = fresh(renderer);
    await f.jobs.create(f.request);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = {...f.request, requestId: randomUUID()};
    await f.jobs.create(second);
    f.store.scenes.save({...f.scene, title: 'Edited after acceptance', masterGain: 0.9}, f.scene.revision);
    const recipe = f.jobs.recipe(second.requestId);
    expect(recipe.scene.title).toBe('Quiet room'); expect(recipe.scene.revision).toBe(1);
    expect(recipe.assets).toEqual([f.asset]);
    recipe.scene.title = 'Caller mutation'; recipe.assets[0]!.provenance.source = 'Caller mutation';
    expect(f.jobs.recipe(second.requestId).assets[0]!.provenance.source).toBe(f.asset.provenance.source);
    gate.resolve();
    await completed(f.jobs, second.requestId);
    expect(maximum).toBe(1); expect(calls).toHaveLength(2);
    expect(calls[1]!.scene.title).toBe('Quiet room'); expect(calls[1]!.scene.masterGain).toBe(0.25);
    expect(calls[1]!.assets[0]!.path).toContain(join('exports', second.requestId, 'work'));
    expect(readFileSync(f.sourcePath)).toEqual(Buffer.from(f.bytes));
    await vi.waitFor(() => expect(existsSync(join(f.root, 'exports', second.requestId, 'work'))).toBe(false));
  });

  it('coalesces identical request IDs even after edits and rejects their reuse with different settings', async () => {
    const renderer = vi.fn(writeResult); const f = fresh(renderer);
    const [a, b] = await Promise.all([f.jobs.create(f.request), f.jobs.create({...f.request})]);
    expect(a.id).toBe(f.request.requestId); expect(b.id).toBe(a.id);
    f.store.scenes.save({...f.scene, title: 'New revision'}, 1);
    expect((await f.jobs.create(f.request)).id).toBe(a.id);
    for (const changed of [{durationSeconds: 0.2}, {expectedRevision: 2}, {sceneId: 'different-scene'}]) {
      await expect(f.jobs.create({...f.request, ...changed})).rejects.toMatchObject({code: 'EXPORT_REQUEST_CONFLICT', statusCode: 409});
    }
    await completed(f.jobs, a.id);
    expect(renderer).toHaveBeenCalledTimes(1); expect(f.jobs.list()).toHaveLength(1);
  });

  it('rejects a stale revision before accepting any work', async () => {
    const f = fresh(); f.store.scenes.save({...f.scene, title: 'Current'}, 1);
    await expect(f.jobs.create(f.request)).rejects.toMatchObject({code: 'REVISION_CONFLICT', currentRevision: 2});
    expect(f.jobs.list()).toEqual([]); expect(readdirSync(join(f.root, 'exports'))).toEqual([]);
  });

  it('captures listening settings independently of export duration and subsequent session edits', async () => {
    const gate=deferred();
    const renderer=vi.fn(async (options:ExportRenderOptions)=>{await waitForRelease(gate,options.signal);return writeResult(options);});
    const f=fresh(renderer);
    const listeningTimer={enabled:true,durationSeconds:30,fadeInSeconds:.04,fadeOutSeconds:.08};
    const saved=f.store.scenes.save({...f.scene,listeningTimer},f.scene.revision);
    const request={...f.request,expectedRevision:saved.revision,durationSeconds:.2};
    await f.jobs.create(request);
    await vi.waitFor(()=>expect(renderer).toHaveBeenCalledTimes(1));
    f.store.scenes.save({...saved,listeningTimer:{...listeningTimer,enabled:false,fadeOutSeconds:2}},saved.revision);
    const recipe=f.jobs.recipe(request.requestId);
    expect(recipe.scene.listeningTimer).toEqual(listeningTimer);expect(recipe.durationSeconds).toBe(.2);
    expect(renderer.mock.calls[0]![0]).toMatchObject({scene:{listeningTimer},durationSeconds:.2});
    recipe.scene.listeningTimer!.fadeInSeconds=1;
    expect(f.jobs.recipe(request.requestId).scene.listeningTimer).toEqual(listeningTimer);
    gate.resolve();await completed(f.jobs,request.requestId);
  });

  it('cancels queued work without starting it and waits for running owned work to settle', async () => {
    const gate = deferred(); const aborted = deferred(); let ended = false;
    const renderer = vi.fn(async (options: ExportRenderOptions) => {
      options.signal.addEventListener('abort', aborted.resolve, {once: true});
      await writeFile(options.outputPath, 'partial');
      await gate.promise;
      ended = true; options.signal.throwIfAborted();
      return writeResult(options);
    });
    const f = fresh(renderer); await f.jobs.create(f.request);
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledTimes(1));
    const second = {...f.request, requestId: randomUUID()}; await f.jobs.create(second);
    expect((await f.jobs.cancel(second.requestId)).status).toBe('cancelled');
    let returned = false;
    const cancellation = f.jobs.cancel(f.request.requestId).then(job => { returned = true; return job; });
    await aborted.promise;
    expect(returned).toBe(false); expect(ended).toBe(false);
    gate.resolve();
    expect((await cancellation).status).toBe('cancelled'); expect(ended).toBe(true);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect((await f.jobs.cancel(f.request.requestId)).status).toBe('cancelled');
    await expect(f.jobs.openContent(f.request.requestId)).rejects.toMatchObject({code: 'EXPORT_NOT_COMPLETE'});
    expect(existsSync(join(f.root, 'exports', f.request.requestId, 'output.wav'))).toBe(false);
  });

  it('marks graceful shutdown as interruption and does not start queued work', async () => {
    const gate = deferred(); const renderer = vi.fn(async (options: ExportRenderOptions) => {
      await waitForRelease(gate, options.signal); return writeResult(options);
    });
    const f = fresh(renderer); await f.jobs.create(f.request);
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledTimes(1));
    const second = {...f.request, requestId: randomUUID()}; await f.jobs.create(second);
    await f.jobs.close();
    expect(f.jobs.get(f.request.requestId).status).toBe('interrupted');
    expect(f.jobs.get(second.requestId).status).toBe('interrupted');
    expect(renderer).toHaveBeenCalledTimes(1);
    await expect(f.jobs.create({...f.request, requestId: randomUUID()})).rejects.toMatchObject({code: 'EXPORTS_CLOSING'});
  });

  it.each(['queued', 'rendering'] as const)('recovers completed artifacts and interrupts %s crash leftovers without exposing partial files or retrying', async status => {
    const f = fresh(); await f.jobs.create(f.request); await completed(f.jobs, f.request.requestId);
    const other = {...f.request, requestId: randomUUID()}; await f.jobs.create(other); await completed(f.jobs, other.requestId);
    await f.jobs.close();
    const directory = join(f.root, 'exports', other.requestId);
    const stored = JSON.parse(readFileSync(join(directory, 'job.json'), 'utf8'));
    stored.job.status = status; stored.job.result = null; stored.job.progress = 0.5;
    writeFileSync(join(directory, 'job.json'), JSON.stringify(stored));
    writeFileSync(join(directory, 'output.part.wav'), 'incomplete');
    const untouched = join(f.root, 'exports', 'user-notes.txt'); writeFileSync(untouched, 'keep');
    const completedWork = join(f.root, 'exports', f.request.requestId, 'work');
    mkdirSync(completedWork); writeFileSync(join(completedWork, 'leftover'), 'owned temporary content');
    const renderer = vi.fn(writeResult);
    const recovered = new ExportJobs({root: join(f.root, 'exports'), scenes: f.store.scenes, assets: f.assets, renderer}); queues.push(recovered);
    expect(recovered.get(other.requestId)).toMatchObject({status: 'interrupted', result: null});
    expect((await recovered.create(other)).status).toBe('interrupted');
    expect(renderer).not.toHaveBeenCalled();
    expect(existsSync(completedWork)).toBe(false);
    expect(existsSync(join(directory, 'output.part.wav'))).toBe(false); expect(existsSync(join(directory, 'output.wav'))).toBe(false);
    expect(readFileSync(untouched, 'utf8')).toBe('keep');
    await expect(recovered.openContent(other.requestId)).rejects.toMatchObject({code: 'EXPORT_NOT_COMPLETE'});
    const content = await recovered.openContent(f.request.requestId); const parts: Buffer[] = [];
    for await (const part of content.stream) parts.push(Buffer.from(part));
    expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(recovered.get(f.request.requestId).result!.sha256);
    expect(recovered.recipe(f.request.requestId)).toEqual(f.jobs.recipe(f.request.requestId));
  });

  it('rejects replaced source bytes before invoking the renderer and publishes a private safe error', async () => {
    const renderer = vi.fn(writeResult); const f = fresh(renderer);
    const changed = Buffer.from(f.bytes); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    writeFileSync(f.sourcePath, changed);
    await f.jobs.create(f.request);
    await vi.waitFor(() => expect(f.jobs.get(f.request.requestId).status).toBe('failed'));
    const job = f.jobs.get(f.request.requestId);
    expect(renderer).not.toHaveBeenCalled(); expect(job.error).not.toContain(f.root); expect(job.error).not.toContain(f.sourcePath);
    expect(job.result).toBeNull();
    await vi.waitFor(() => expect(existsSync(join(f.root, 'exports', f.request.requestId, 'work'))).toBe(false));
  });

  it('never serves an output that disagrees with its completed digest', async () => {
    const f = fresh(); await f.jobs.create(f.request); await completed(f.jobs, f.request.requestId);
    const path = join(f.root, 'exports', f.request.requestId, 'output.wav');
    const changed = readFileSync(path); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1; writeFileSync(path, changed);
    await expect(f.jobs.openContent(f.request.requestId)).rejects.toMatchObject({code: 'EXPORT_UNAVAILABLE', statusCode: 410});
  });

  it('checks the renderer result against the actual output before publishing completion', async () => {
    const f = fresh(async options => ({...await writeResult(options), sha256: '0'.repeat(64)}));
    await f.jobs.create(f.request);
    await vi.waitFor(() => expect(f.jobs.get(f.request.requestId).status).toBe('failed'));
    expect(f.jobs.get(f.request.requestId).result).toBeNull();
    expect(existsSync(join(f.root, 'exports', f.request.requestId, 'output.wav'))).toBe(false);
    expect(existsSync(join(f.root, 'exports', f.request.requestId, 'output.part.wav'))).toBe(false);
  });

  it.each(['EXPORT_BUDGET_EXCEEDED', 'UNKNOWN_RENDERER_ERROR'])('only exposes the approved budget diagnostic for %s', async code => {
    const message = code === 'EXPORT_BUDGET_EXCEEDED'
      ? 'This mix exceeds the export memory budget. Try shorter loops or fewer layers.'
      : '/private/recording/source.wav: unapproved renderer diagnostic';
    const f = fresh(async () => { throw new StudioError(code, message, 422); });
    await f.jobs.create(f.request);
    await vi.waitFor(() => expect(f.jobs.get(f.request.requestId).status).toBe('failed'));
    if (code === 'EXPORT_BUDGET_EXCEEDED') expect(f.jobs.get(f.request.requestId).error).toBe(message);
    else expect(f.jobs.get(f.request.requestId).error).not.toContain('/private');
  });
});

describe('export API boundary', () => {
  it.each([
    {name:'overlapping fades',durationSeconds:.1,fadeInSeconds:.04,fadeOutSeconds:.08},
    {name:'overlap after output-frame rounding',durationSeconds:.100005,fadeInSeconds:.05,fadeOutSeconds:.050001},
  ])('explains $name and rejects it before acknowledging or creating a job',async({durationSeconds,fadeInSeconds,fadeOutSeconds})=>{
    const renderer=vi.fn(writeResult),f=fresh(renderer);
    const saved=f.store.scenes.save({...f.scene,listeningTimer:{enabled:true,durationSeconds:2,fadeInSeconds,fadeOutSeconds}},f.scene.revision);
    const app=buildApp({scenes:f.store.scenes,assets:f.assets,exports:f.jobs,allowedOrigin:origin});applications.push(app);
    const response=await app.inject({method:'POST',url:'/api/exports',headers,payload:{...f.request,expectedRevision:saved.revision,durationSeconds}});
    expect(response.statusCode).toBe(422);expect(response.json()).toMatchObject({code:'EXPORT_FADE_INVALID'});
    expect(response.json().message).toMatch(/fade/i);
    expect(f.jobs.list()).toEqual([]);expect(readdirSync(join(f.root,'exports'))).toEqual([]);expect(renderer).not.toHaveBeenCalled();
    expect(f.store.scenes.get(saved.id)).toEqual(saved);expect(readFileSync(f.sourcePath)).toEqual(Buffer.from(f.bytes));
  });
  it('accepts strict requests, returns direct job states, and downloads verified WAV and immutable recipe', async () => {
    const f = fresh();
    f.store.scenes.save({...f.scene, title: 'title"\r\nInjected: unsafe/../../name'}, 1);
    const request = {...f.request, expectedRevision: 2};
    const app = buildApp({scenes: f.store.scenes, assets: f.assets, exports: f.jobs, allowedOrigin: origin}); applications.push(app);
    const accepted = await app.inject({method: 'POST', url: '/api/exports', headers, payload: request});
    expect(accepted.statusCode).toBe(202); expect(accepted.json().id).toBe(request.requestId);
    const repeated = await app.inject({method: 'POST', url: '/api/exports', headers, payload: request});
    expect(repeated.statusCode).toBe(202); expect(repeated.json().id).toBe(request.requestId);
    const conflict = await app.inject({method: 'POST', url: '/api/exports', headers, payload: {...request, durationSeconds: 0.2}});
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('EXPORT_REQUEST_CONFLICT');
    await completed(f.jobs, request.requestId);
    const status = await app.inject({method: 'GET', url: `/api/exports/${request.requestId}`, headers});
    expect(status.json().status).toBe('complete');
    const list = await app.inject({method: 'GET', url: '/api/exports', headers}); expect(list.json()).toHaveLength(1);
    const content = await app.inject({method: 'GET', url: `/api/exports/${request.requestId}/content`, headers});
    expect(content.statusCode).toBe(200); expect(content.headers['content-type']).toBe('audio/wav');
    expect(content.headers['content-disposition']).toBe(`attachment; filename="asmr-${request.requestId}.wav"`);
    expect(content.headers['x-content-type-options']).toBe('nosniff'); expect(content.headers['cache-control']).toBe('no-store');
    expect(content.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(createHash('sha256').update(content.rawPayload).digest('hex')).toBe(status.json().result.sha256);
    const recipe = await app.inject({method: 'GET', url: `/api/exports/${request.requestId}/recipe`, headers});
    expect(recipe.json().scene.revision).toBe(2); expect(recipe.json().assets).toEqual([f.asset]);
    const cancelled = await app.inject({method: 'POST', url: `/api/exports/${request.requestId}/cancel`, headers, payload: {}});
    expect(cancelled.statusCode).toBe(200); expect(cancelled.json().status).toBe('complete');
  });

  it('rejects extra paths, malformed identities, stale revisions, nonempty cancellation bodies, and hostile origins', async () => {
    const f = fresh(); const app = buildApp({scenes: f.store.scenes, assets: f.assets, exports: f.jobs, allowedOrigin: origin}); applications.push(app);
    for (const payload of [{...f.request, outputPath: '/tmp/escape.wav'}, {...f.request, requestId: '../../escape'},
      {...f.request, expectedRevision: 0}, {...f.request, durationSeconds: MAX_EXPORT_SECONDS + 1},
      {...f.request, durationSeconds: 0}, {...f.request, durationSeconds: 1 / (48_000 * 3)}]) {
      expect((await app.inject({method: 'POST', url: '/api/exports', headers, payload})).statusCode).toBe(400);
    }
    expect((await app.inject({method: 'GET', url: '/api/exports/..%2F..%2Fescape/content', headers})).statusCode).toBe(400);
    expect((await app.inject({method: 'POST', url: '/api/exports', headers: {...headers, origin: 'https://attacker.example'}, payload: f.request})).statusCode).toBe(403);
    expect((await app.inject({method: 'POST', url: `/api/exports/${f.request.requestId}/cancel`, headers, payload: {signal: 'SIGKILL'}})).statusCode).toBe(400);
    f.store.scenes.save({...f.scene, title: 'Updated'}, 1);
    const stale = await app.inject({method: 'POST', url: '/api/exports', headers, payload: f.request});
    expect(stale.statusCode).toBe(409); expect(stale.json().currentRevision).toBe(2);
    expect(f.jobs.list()).toEqual([]);
  });

  it('keeps renderer diagnostics and partial output out of failed job responses', async () => {
    const f = fresh(async options => {
      await writeFile(options.outputPath, 'partial');
      throw new Error('ffmpeg: /private/person/recordings/secret.wav could not be opened');
    });
    const app = buildApp({scenes: f.store.scenes, assets: f.assets, exports: f.jobs, allowedOrigin: origin}); applications.push(app);
    await app.inject({method: 'POST', url: '/api/exports', headers, payload: f.request});
    await vi.waitFor(() => expect(f.jobs.get(f.request.requestId).status).toBe('failed'));
    const status = await app.inject({method: 'GET', url: `/api/exports/${f.request.requestId}`, headers});
    expect(status.body).not.toContain('/private'); expect(status.body).not.toContain('secret.wav'); expect(status.body).not.toContain(f.root);
    expect(status.json().result).toBeNull();
    const unavailable = await app.inject({method: 'GET', url: `/api/exports/${f.request.requestId}/content`, headers});
    expect(unavailable.statusCode).toBe(409);
    expect(existsSync(join(f.root, 'exports', f.request.requestId, 'output.part.wav'))).toBe(false);
  });
});
