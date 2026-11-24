import {loopSchema,type Layer,type Loop} from '@asmr-studio/contracts';

export const roleNames: Record<Layer['role'], string> = {
  ambience: 'Ambience',
  texture: 'Texture',
  narration: 'Narration',
};

export function formatDuration(seconds: number): string {
  if (seconds < 1) return seconds.toFixed(2) + ' s';
  const total = Math.ceil(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remainder = String(total % 60).padStart(2, '0');
  return hours > 0
    ? hours + ':' + String(minutes).padStart(2, '0') + ':' + remainder
    : minutes + ':' + remainder;
}

export function defaultLoop(durationSeconds: number, preferred?:Loop): NonNullable<Layer['loop']> {
  const prepared=preferred===undefined?null:loopSchema.safeParse(preferred);
  if(prepared?.success&&prepared.data.endSeconds<=durationSeconds)return prepared.data;
  // Leave the same small decoder-tail margin used by automatic imports.
  return {
    startSeconds: 0,
    endSeconds: durationSeconds - Math.min(.025, durationSeconds / 4),
    crossfadeSeconds: Math.min(.02, durationSeconds / 8),
  };
}
