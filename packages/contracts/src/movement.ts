import {z} from 'zod';

export const STEREO_MOVEMENT_MIN_CYCLE_SECONDS=2;
export const STEREO_MOVEMENT_MAX_CYCLE_SECONDS=600;

export const stereoMovementSchema=z.strictObject({
  enabled:z.boolean(),
  width:z.number().finite().min(0).max(1),
  cycleSeconds:z.number().finite().min(STEREO_MOVEMENT_MIN_CYCLE_SECONDS).max(STEREO_MOVEMENT_MAX_CYCLE_SECONDS),
});

export type StereoMovementSettings=z.output<typeof stereoMovementSchema>;

/** Starting controls only; legacy layer recipes keep this optional field absent. */
export function defaultStereoMovement():StereoMovementSettings {
  return {enabled:false,width:.3,cycleSeconds:30};
}
