import {z} from 'zod';

export const listeningTimerSchema=z.strictObject({
  enabled:z.boolean(),
  durationSeconds:z.number().finite().positive(),
  fadeInSeconds:z.number().finite().min(0),
  fadeOutSeconds:z.number().finite().min(0),
}).superRefine((timer,ctx)=>{
  if(timer.fadeInSeconds+timer.fadeOutSeconds>timer.durationSeconds)
    ctx.addIssue({code:'custom',message:'Fade-in and fade-out must fit within the listening duration.',path:['durationSeconds']});
});
export type ListeningTimerSettings=z.output<typeof listeningTimerSchema>;

/** Starting controls only; old recipes retain their optional field identity. */
export function defaultListeningTimer():ListeningTimerSettings {
  return {enabled:false,durationSeconds:2700,fadeInSeconds:0,fadeOutSeconds:180};
}
/** Explicit timer settings supersede the legacy scene duration. */
export function listeningDuration(settings:ListeningTimerSettings|undefined,legacyDuration:number|null):number|null {
  return settings===undefined?legacyDuration:settings.enabled?settings.durationSeconds:null;
}
/** The caller supplies the actual endpoint, including any export frame rounding. */
export function listeningFadeError(settings:ListeningTimerSettings|undefined,endpointSeconds:number):string|null {
  return settings?.enabled&&settings.fadeInSeconds+settings.fadeOutSeconds>endpointSeconds
    ? 'Fade-in and fade-out must fit within the selected duration.' : null;
}
