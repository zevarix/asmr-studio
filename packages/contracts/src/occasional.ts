import {z} from 'zod';

export const OCCASIONAL_MIN_PAUSE_SECONDS=.25;
export const OCCASIONAL_MAX_PAUSE_SECONDS=3600;
export const OCCASIONAL_MAX_ALTERNATES=7;
export const OCCASIONAL_MAX_VARIATION=.25;

export const occasionalSchema=z.strictObject({
  enabled:z.boolean(),
  minPauseSeconds:z.number().finite().min(OCCASIONAL_MIN_PAUSE_SECONDS).max(OCCASIONAL_MAX_PAUSE_SECONDS),
  maxPauseSeconds:z.number().finite().min(OCCASIONAL_MIN_PAUSE_SECONDS).max(OCCASIONAL_MAX_PAUSE_SECONDS),
  seed:z.number().int().min(0).max(0xffff_ffff),
  alternateAssetIds:z.array(z.string().refine(value=>value.trim().length>0,'Must not be blank')).max(OCCASIONAL_MAX_ALTERNATES),
  levelVariation:z.number().finite().min(0).max(OCCASIONAL_MAX_VARIATION),
  panVariation:z.number().finite().min(0).max(OCCASIONAL_MAX_VARIATION),
}).superRefine((settings,ctx)=>{
  if(settings.minPauseSeconds>settings.maxPauseSeconds)ctx.addIssue({code:'custom',message:'Minimum pause must not exceed maximum pause',path:['maxPauseSeconds']});
  if(new Set(settings.alternateAssetIds).size!==settings.alternateAssetIds.length)ctx.addIssue({code:'custom',message:'Alternate recordings must be unique',path:['alternateAssetIds']});
});

export type OccasionalSettings=z.output<typeof occasionalSchema>;

/** Defaults are explicit when enabled; parsing old scenes never inserts them. */
export function defaultOccasional(seed=1):OccasionalSettings {
  return {enabled:false,minPauseSeconds:4,maxPauseSeconds:12,seed,alternateAssetIds:[],levelVariation:0,panVariation:0};
}

interface AssetReferences {assetId:string;occasional?:OccasionalSettings|undefined}
/** Saved alternates retain their references, provenance and rights even while disabled. */
export function layerAssetIds(layer:AssetReferences):string[] {
  return [layer.assetId,...(layer.occasional?.alternateAssetIds??[])];
}
export function playbackAssetIds(layer:AssetReferences):string[] {
  return layer.occasional?.enabled?layerAssetIds(layer):[layer.assetId];
}
