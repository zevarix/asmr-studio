import {z} from 'zod';

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
const decibels = z.number().finite().min(EQ_MIN_DB).max(EQ_MAX_DB);

export const equalizerSchema = z.strictObject({
  bassDb: decibels,
  midDb: decibels,
  trebleDb: decibels,
  bypassed: z.boolean(),
});
export type EqualizerSettings = z.output<typeof equalizerSchema>;

/** A fresh neutral value for an explicit reset; legacy recipes need no new default fields. */
export function flatEqualizer(): EqualizerSettings {
  return {bassDb: 0, midDb: 0, trebleDb: 0, bypassed: false};
}
