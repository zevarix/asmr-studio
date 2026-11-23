import { z } from 'zod';
import {equalizerSchema} from './equalizer.js';
import {outputLimiterSchema} from './output.js';
import {stereoMovementSchema} from './movement.js';
import {listeningTimerSchema} from './listening-timer.js';
import {occasionalSchema,layerAssetIds} from './occasional.js';

const nonempty = z.string().refine(value => value.trim().length > 0, 'Must not be blank');
const finite = z.number().finite();
const gain = finite.min(0).max(1);
export const roleSchema = z.enum(['ambience', 'texture', 'narration']);
export const loopSchema = z.strictObject({
  startSeconds: finite.min(0),
  endSeconds: finite.min(0),
  crossfadeSeconds: finite.min(0),
}).superRefine((loop, ctx) => {
  const interval = loop.endSeconds - loop.startSeconds;
  if (interval <= 0) ctx.addIssue({code:'custom',message:'Loop end must follow its start',path:['endSeconds']});
  if (loop.crossfadeSeconds > interval / 2) ctx.addIssue({code:'custom',message:'Crossfade must not exceed half the loop interval',path:['crossfadeSeconds']});
});

export const layerSchema = z.strictObject({
  id: nonempty,
  assetId: nonempty,
  role: roleSchema,
  gain,
  pan: finite.min(-1).max(1),
  muted: z.boolean(),
  solo: z.boolean(),
  startSeconds: finite.min(0),
  loop: loopSchema.nullable().default(null),
  equalizer: equalizerSchema.optional(),
  movement: stereoMovementSchema.optional(),
  occasional: occasionalSchema.optional(),
}).superRefine((layer,ctx)=>{
  if(layer.occasional?.alternateAssetIds.includes(layer.assetId))ctx.addIssue({code:'custom',message:'The primary recording is already included',path:['occasional','alternateAssetIds']});
});

const mixSceneFields = {
  schemaVersion: z.literal(1),
  id: nonempty,
  title: nonempty,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  masterGain: gain,
  masterEqualizer: equalizerSchema.optional(),
  outputLimiter: outputLimiterSchema.optional(),
  listeningTimer: listeningTimerSchema.optional(),
  durationSeconds: finite.positive().nullable(),
  layers: z.array(layerSchema),
};
function uniqueLayers(scene:{layers:Array<{id:string}>},ctx:z.RefinementCtx):void {
  const seen = new Set<string>();
  for (const [index, layer] of scene.layers.entries()) {
    if (seen.has(layer.id)) ctx.addIssue({code:'custom',message:'Layer IDs must be unique',path:['layers',index,'id']});
    seen.add(layer.id);
  }
}
/** Captures are deliberately nonrecursive: only ordinary mixes may be a side. */
export const mixSceneSchema = z.strictObject(mixSceneFields).superRefine(uniqueLayers);

export const assetImportMetadataSchema = z.strictObject({
  displayName: nonempty,
  roles: z.array(roleSchema).min(1),
  provenance: z.strictObject({kind:z.enum(['original','licensed','unknown']), source:nonempty.nullable()}),
  rights: z.strictObject({privateUse:z.enum(['permitted','unknown']), redistribution:z.enum(['permitted','forbidden','unknown'])}),
});
export const assetRecordSchema = assetImportMetadataSchema.extend({
  id: nonempty,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationSeconds: finite.positive(),
  sampleRate: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  channels: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  format: nonempty,
});

export const capturedMixSchema = z.strictObject({
  id: nonempty,
  scene: mixSceneSchema.refine(scene=>scene.revision>=1,'Only a saved mix can be captured'),
  assets: z.array(assetRecordSchema),
}).superRefine((capture,ctx)=>{
  const required=new Set(capture.scene.layers.flatMap(layerAssetIds));
  const records=new Map(capture.assets.map(asset=>[asset.id,asset]));
  if(records.size!==capture.assets.length||records.size!==required.size||[...required].some(id=>!records.has(id)))
    ctx.addIssue({code:'custom',message:'Captured assets must uniquely and exactly cover the saved mix',path:['assets']});
  for(const [index,layer] of capture.scene.layers.entries()){
    const asset=records.get(layer.assetId);
    if(asset&&layer.loop&&layer.loop.endSeconds>asset.durationSeconds)
      ctx.addIssue({code:'custom',message:'Loop extends beyond the captured recording',path:['scene','layers',index,'loop','endSeconds']});
  }
});

export const mixTransitionSchema = z.strictObject({
  a:capturedMixSchema.nullable(),
  b:capturedMixSchema.nullable(),
  curve:z.literal('linear'),
  mode:z.enum(['manual','timed']),
  blend:gain,
  durationSeconds:finite.min(.1).max(3600),
  startSeconds:finite.min(0),
  startPositions:z.strictObject({a:z.literal(0),b:z.literal(0)}),
}).superRefine((transition,ctx)=>{
  const records=new Map(transition.a?.assets.map(asset=>[asset.id,asset])??[]);
  for(const [index,asset] of (transition.b?.assets??[]).entries()){
    const previous=records.get(asset.id);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(asset))
      ctx.addIssue({code:'custom',message:'Shared asset IDs must describe the same captured recording',path:['b','assets',index]});
  }
});

export const sceneSchema = z.strictObject({...mixSceneFields,transition:mixTransitionSchema.optional()})
  .superRefine((scene,ctx)=>{
    uniqueLayers(scene,ctx);
    if(!scene.transition)return;
    if(scene.layers.length!==0)ctx.addIssue({code:'custom',message:'Transition arrangements contain captured mixes instead of ordinary layers',path:['layers']});
    if(scene.durationSeconds!==null)ctx.addIssue({code:'custom',message:'Transition duration is set by its captured sources or finite export',path:['durationSeconds']});
    if(scene.masterEqualizer!==undefined)ctx.addIssue({code:'custom',message:'EQ belongs to each captured mix',path:['masterEqualizer']});
    if(scene.listeningTimer!==undefined)ctx.addIssue({code:'custom',message:'Listening timers belong to each captured mix',path:['listeningTimer']});
    for(const side of ['a','b'] as const)if(scene.transition[side]?.scene.id===scene.id)
      ctx.addIssue({code:'custom',message:'An arrangement must have a different identity from its source mixes',path:['transition',side,'scene','id']});
  });

export type Layer = z.output<typeof layerSchema>;
export type Loop = z.output<typeof loopSchema>;
export type Scene = z.output<typeof sceneSchema>;
export type MixScene = z.output<typeof mixSceneSchema>;
export type CapturedMix = z.output<typeof capturedMixSchema>;
export type MixTransition = z.output<typeof mixTransitionSchema>;
export type AssetRecord = z.output<typeof assetRecordSchema>;
export type AssetImportMetadata = z.output<typeof assetImportMetadataSchema>;

/** A boundary failure, never a partially accepted or silently repaired recipe. */
export class SceneValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string, readonly issues: readonly z.core.$ZodIssue[] = []) {
    super(message);
    this.name = 'SceneValidationError';
  }
}

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SceneValidationError('Invalid scene or asset data', result.error.issues);
  return result.data;
}
export function parseScene(input: unknown): Scene { return parseWith(sceneSchema, input); }
export function parseCapturedMix(input:unknown):CapturedMix {return parseWith(capturedMixSchema,input);}
export function parseAssetRecord(input: unknown): AssetRecord { return parseWith(assetRecordSchema, input); }
export function parseAssetImportMetadata(input: unknown): AssetImportMetadata { return parseWith(assetImportMetadataSchema, input); }
export function createEmptyScene(id: string, title: string): Scene {
  return parseScene({schemaVersion:1,id,title,revision:0,masterGain:0.25,durationSeconds:null,layers:[]});
}
export function createEmptyTransition(id:string,title:string):Scene {
  return parseScene({schemaVersion:1,id,title,revision:0,masterGain:1,outputLimiter:{enabled:true,ceilingDb:-1},durationSeconds:null,layers:[],
    transition:{a:null,b:null,curve:'linear',mode:'manual',blend:0,durationSeconds:30,startSeconds:0,startPositions:{a:0,b:0}}});
}
