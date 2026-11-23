import Fastify, { type FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { parseAssetImportMetadata, parseExportRequest, parseScene, SceneValidationError, type AssetRecord } from '@asmr-studio/contracts';
import { AssetStore, type ByteRange } from './assets.js';
import type { ExportJobs } from './exports.js';
import type { SceneStore } from './store.js';
import { NotFound, RevisionConflict, StudioError } from './errors.js';

function rangeFromHeader(header:string|undefined,size:number):ByteRange|undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new StudioError('INVALID_RANGE','Only a single valid byte range is supported',416);
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new StudioError('INVALID_RANGE','Invalid suffix range',416);
    return {start:Math.max(0,size-suffix),endInclusive:size-1};
  }
  const start = Number(match[1]); const end = match[2] ? Number(match[2]) : size-1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new StudioError('INVALID_RANGE','Range is outside the audio content',416);
  return {start,endInclusive:Math.min(end,size-1)};
}

export function buildApp(deps:{scenes:SceneStore;assets:AssetStore;allowedOrigin:string;exports?:ExportJobs;starterLibrary?:{install():Promise<AssetRecord[]>;catalog():unknown}}):FastifyInstance {
  const allowed = new URL(deps.allowedOrigin);
  if (allowed.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(allowed.hostname) || allowed.origin !== deps.allowedOrigin) {
    throw new Error('M1 requires an explicit loopback HTTP origin');
  }
  const app = Fastify({logger:false,bodyLimit:1024*1024,requestTimeout:120000});
  app.addHook('onRequest',async (request,reply) => {
    const origin = request.headers.origin;
    const mutation = !['GET','HEAD','OPTIONS'].includes(request.method);
    if (request.headers.host !== allowed.host || (origin !== undefined && origin !== allowed.origin) || (mutation && origin !== allowed.origin)) {
      return reply.code(403).send({code:'ORIGIN_REJECTED',message:'This request is not from the selected local studio'});
    }
  });
  app.addHook('onSend',async (_request,reply,payload) => {
    reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');
    return payload;
  });
  app.addContentTypeParser('application/octet-stream',(_request,payload,done) => done(null,payload));
  app.addContentTypeParser(/^audio\//,(_request,payload,done) => done(null,payload));
  app.setErrorHandler((error,_request,reply) => {
    if (error instanceof RevisionConflict) return reply.code(409).send({code:error.code,message:error.message,currentRevision:error.currentRevision});
    if (error instanceof StudioError) return reply.code(error.statusCode).send({code:error.code,message:error.message});
    if (error instanceof SceneValidationError || error instanceof SyntaxError) return reply.code(400).send({code:'VALIDATION_ERROR',message:'The request does not match the studio contract'});
    const status = (error as {statusCode?:number}).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({code:'INVALID_REQUEST',message:'The request could not be accepted'});
    return reply.code(500).send({code:'INTERNAL_ERROR',message:'The operation failed without a confirmed result'});
  });
  app.get('/api/health',async () => ({status:'ok',schemaVersion:1}));
  if (deps.exports) {
    const exports = deps.exports;
    app.post('/api/exports',async (request,reply) => reply.code(202).send(await exports.create(parseExportRequest(request.body))));
    app.get('/api/exports',async () => exports.list());
    app.get<{Params:{id:string}}>('/api/exports/:id',async request => exports.get(request.params.id));
    app.post<{Params:{id:string}}>('/api/exports/:id/cancel',async request => {
      if (request.body !== undefined && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
        throw new SceneValidationError('Cancelling an export does not accept settings');
      }
      return exports.cancel(request.params.id);
    });
    app.get<{Params:{id:string}}>('/api/exports/:id/content',async (request,reply) => {
      const content = await exports.openContent(request.params.id);
      return reply.type('audio/wav').header('Content-Length',content.bytes)
        .header('Content-Disposition',`attachment; filename="${content.filename}"`).send(content.stream);
    });
    app.get<{Params:{id:string}}>('/api/exports/:id/recipe',async (request,reply) => {
      const recipe = exports.recipe(request.params.id);
      return reply.type('application/json').header('Content-Disposition',`attachment; filename="asmr-${recipe.id}-recipe.json"`).send(recipe);
    });
  }
  app.get('/api/assets',async () => deps.assets.list());
  if (deps.starterLibrary) {
    const library = deps.starterLibrary;
    app.get('/api/library',async () => library.catalog());
    app.post('/api/library/install',async (request) => {
      if (request.body !== undefined && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
        throw new SceneValidationError('Sound installation does not accept source URLs or settings');
      }
      return library.install();
    });
  }
  app.post('/api/assets',async (request,reply) => {
    const raw = request.headers['x-asmr-metadata'];
    if (typeof raw !== 'string') throw new SceneValidationError('Asset import metadata is required');
    const metadata = parseAssetImportMetadata(JSON.parse(raw));
    const body = request.body as Readable|undefined;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new SceneValidationError('The body must be an audio byte stream');
    const asset = await deps.assets.ingest(body,metadata,request.headers['content-type'] ?? 'application/octet-stream');
    return reply.code(201).send(asset);
  });
  app.get<{Params:{id:string}}>('/api/assets/:id/content',async (request,reply) => {
    const size = deps.assets.byteLength(request.params.id);
    let range:ByteRange|undefined;
    try { range = rangeFromHeader(request.headers.range,size); }
    catch (error) { reply.header('Content-Range',`bytes */${size}`); throw error; }
    const content = deps.assets.openContent(request.params.id,range);
    reply.header('Accept-Ranges','bytes').type(content.contentType);
    if (range) reply.code(206).header('Content-Range',`bytes ${range.start}-${range.endInclusive}/${size}`)
      .header('Content-Length',range.endInclusive-range.start+1);
    else reply.header('Content-Length',size);
    return reply.send(content.stream);
  });
  app.get('/api/scenes',async () => deps.scenes.list());
  app.post('/api/scenes',async (request,reply) => reply.code(201).send(deps.scenes.create(parseScene(request.body))));
  app.post<{Params:{id:string}}>('/api/scenes/:id/capture',async (request,reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('expectedRevision' in body) || typeof body.expectedRevision !== 'number') {
      throw new SceneValidationError('Expected the saved revision to capture');
    }
    return reply.code(201).send(deps.scenes.capture(request.params.id,body.expectedRevision));
  });
  app.get<{Params:{id:string}}>('/api/scenes/:id',async request => {
    const scene = deps.scenes.get(request.params.id);
    if (!scene) throw new NotFound();
    return scene;
  });
  app.put<{Params:{id:string}}>('/api/scenes/:id',async request => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || !('scene' in body) || !('expectedRevision' in body) || typeof body.expectedRevision !== 'number') {
      throw new SceneValidationError('Expected a scene and expectedRevision');
    }
    const scene = parseScene(body.scene);
    if (scene.id !== request.params.id) throw new SceneValidationError('Scene ID does not match the route');
    return deps.scenes.save(scene,body.expectedRevision);
  });
  return app;
}
