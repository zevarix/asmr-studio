import {z} from 'zod';

export const OUTPUT_LIMITER_MIN_DB=-12;
export const OUTPUT_LIMITER_MAX_DB=-0.1;

export const outputLimiterSchema=z.strictObject({
  enabled:z.boolean(),
  ceilingDb:z.number().finite().min(OUTPUT_LIMITER_MIN_DB).max(OUTPUT_LIMITER_MAX_DB),
});

export type OutputLimiterSettings=z.output<typeof outputLimiterSchema>;

/** UI starting values; old recipes keep the optional field absent. */
export function defaultOutputLimiter():OutputLimiterSettings {
  return {enabled:false,ceilingDb:-1};
}
