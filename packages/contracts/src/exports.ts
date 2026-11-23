import { z } from 'zod';
import { assetRecordSchema, parseWith, sceneSchema } from './scene.js';
import {listeningFadeError} from './listening-timer.js';
import {sceneAssetIds} from './transition.js';

export const EXPORT_SAMPLE_RATE = 48_000;
export const EXPORT_CHANNELS = 2;
// Classic RIFF uses a uint32 chunk size. Reserve room for headers, then keep whole PCM16 frames.
export const MAX_EXPORT_SECONDS = Math.floor((0xffff_ffff - 4096) / (EXPORT_CHANNELS * 2)) / EXPORT_SAMPLE_RATE;

export const exportIdSchema = z.uuid();
export const exportRequestSchema = z.strictObject({
  requestId: exportIdSchema,
  sceneId: z.string().refine(value => value.trim().length > 0, 'Must not be blank'),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  durationSeconds: z.number().finite().positive().max(MAX_EXPORT_SECONDS)
    .refine(value => Math.round(value * EXPORT_SAMPLE_RATE) >= 1, 'Duration must contain at least one output frame'),
});

export const exportResultSchema = z.strictObject({
  bytes: z.number().int().positive().max(0xffff_ffff),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationSeconds: z.number().finite().positive().max(MAX_EXPORT_SECONDS),
  sampleRate: z.literal(EXPORT_SAMPLE_RATE),
  channels: z.literal(EXPORT_CHANNELS),
  peak: z.number().finite().min(0),
  rms: z.number().finite().min(0),
  clippedSamples: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const exportJobSchema = z.strictObject({
  id: exportIdSchema,
  sceneId: z.string().min(1),
  sceneRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  title: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  durationSeconds: z.number().finite().positive().max(MAX_EXPORT_SECONDS),
  status: z.enum(['queued', 'rendering', 'complete', 'cancelled', 'failed', 'interrupted']),
  progress: z.number().finite().min(0).max(1),
  error: z.string().min(1).nullable(),
  result: exportResultSchema.nullable(),
}).superRefine((job, ctx) => {
  if (job.status === 'complete' && (!job.result || job.progress !== 1 || job.error !== null)) {
    ctx.addIssue({code:'custom',message:'A completed export requires its verified result and full progress'});
  }
  if (job.status !== 'complete' && job.result !== null) {
    ctx.addIssue({code:'custom',message:'Only a completed export may expose a result'});
  }
});

/** Full asset records retain the accepted attribution, provenance and rights declarations. */
export const exportRecipeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: exportIdSchema,
  createdAt: z.iso.datetime(),
  durationSeconds: z.number().finite().positive().max(MAX_EXPORT_SECONDS),
  scene: sceneSchema,
  assets: z.array(assetRecordSchema),
}).superRefine((recipe, ctx) => {
  const ids = new Set(recipe.assets.map(asset => asset.id));
  if (ids.size !== recipe.assets.length || sceneAssetIds(recipe.scene).some(id=>!ids.has(id))) {
    ctx.addIssue({code:'custom',message:'Export assets must uniquely cover the saved scene'});
  }
  if(recipe.scene.transition){
    const transition=recipe.scene.transition;
    if(!transition.a||!transition.b)ctx.addIssue({code:'custom',message:'Choose both saved mixes before exporting a transition',path:['scene','transition']});
    const records=new Map(recipe.assets.map(asset=>[asset.id,asset]));
    for(const side of [transition.a,transition.b])for(const asset of side?.assets??[]){
      if(JSON.stringify(records.get(asset.id))!==JSON.stringify(asset))
        ctx.addIssue({code:'custom',message:'Export records must match the immutable captured recordings',path:['assets']});
    }
  }
  const fadeError=listeningFadeError(recipe.scene.listeningTimer,Math.round(recipe.durationSeconds*EXPORT_SAMPLE_RATE)/EXPORT_SAMPLE_RATE);
  if(fadeError)ctx.addIssue({code:'custom',message:fadeError,path:['durationSeconds']});
});

export type ExportRequest = z.output<typeof exportRequestSchema>;
export type ExportResult = z.output<typeof exportResultSchema>;
export type ExportJob = z.output<typeof exportJobSchema>;
export type ExportRecipe = z.output<typeof exportRecipeSchema>;
export function parseExportRequest(input: unknown): ExportRequest { return parseWith(exportRequestSchema, input); }
export function parseExportResult(input: unknown): ExportResult { return parseWith(exportResultSchema, input); }
export function parseExportJob(input: unknown): ExportJob { return parseWith(exportJobSchema, input); }
export function parseExportRecipe(input: unknown): ExportRecipe { return parseWith(exportRecipeSchema, input); }
