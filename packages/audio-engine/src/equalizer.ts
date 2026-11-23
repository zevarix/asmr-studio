import {equalizerSchema, parseWith, SceneValidationError, type EqualizerSettings} from '@asmr-studio/contracts';

export interface EqualizerBand {
  readonly key: 'bassDb' | 'midDb' | 'trebleDb';
  readonly type: 'lowshelf' | 'peaking' | 'highshelf';
  readonly frequency: number;
  readonly Q?: number;
}
export const EQ_BANDS: readonly EqualizerBand[] = Object.freeze([
  Object.freeze({key: 'bassDb', type: 'lowshelf', frequency: 200} as const),
  Object.freeze({key: 'midDb', type: 'peaking', frequency: 1000, Q: Math.SQRT1_2} as const),
  Object.freeze({key: 'trebleDb', type: 'highshelf', frequency: 4000} as const),
]);

/** H(z) = (b0 + b1 z^-1 + b2 z^-2) / (a0 + a1 z^-1 + a2 z^-2). */
export interface BiquadCoefficients { a0: number; a1: number; a2: number; b0: number; b1: number; b2: number }

/**
 * The normative Web Audio biquads, including its fixed S=1 shelf slope:
 * https://www.w3.org/TR/webaudio/#filters-characteristics
 * Derivation: https://www.w3.org/TR/audio-eq-cookbook/
 * Coefficients retain a0 and denominator signs; consumers must not normalize DC gain.
 */
export function equalizerCoefficients(settings: EqualizerSettings | undefined, sampleRate: number): BiquadCoefficients[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new SceneValidationError('A positive finite equalizer sample rate is required');
  const equalizer = settings === undefined ? undefined : parseWith(equalizerSchema, settings);
  if (!equalizer || equalizer.bypassed) return [];
  const result: BiquadCoefficients[] = [];
  for (const band of EQ_BANDS) {
    // AudioParam values are floats; retain double precision for the filter arithmetic itself.
    const gain = Math.fround(equalizer[band.key]);
    if (gain === 0) continue;
    const frequency = Math.min(band.frequency, sampleRate / 2);
    if (frequency === sampleRate / 2) {
      // Limit cases avoid cancelling a repeated pole at Nyquist in a generic IIR implementation.
      if (band.type === 'lowshelf') result.push({a0: 1, a1: 0, a2: 0, b0: 10 ** (gain / 20), b1: 0, b2: 0});
      continue; // A peaking/high-shelf filter at Nyquist has no in-band effect.
    }
    const A = 10 ** (gain / 40);
    const omega = 2 * Math.PI * frequency / sampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    if (band.type === 'peaking') {
      const alpha = sine / (2 * Math.fround(band.Q!));
      result.push({b0: 1 + alpha * A, b1: -2 * cosine, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cosine, a2: 1 - alpha / A});
      continue;
    }
    // With Web Audio's S=1, alpha_S = sin(omega)/sqrt(2).
    const slope = 2 * Math.sqrt(A) * sine * Math.SQRT1_2;
    const plus = A + 1;
    const minus = A - 1;
    if (band.type === 'lowshelf') {
      result.push({b0: A * (plus - minus * cosine + slope), b1: 2 * A * (minus - plus * cosine),
        b2: A * (plus - minus * cosine - slope), a0: plus + minus * cosine + slope,
        a1: -2 * (minus + plus * cosine), a2: plus + minus * cosine - slope});
    } else {
      result.push({b0: A * (plus + minus * cosine + slope), b1: -2 * A * (minus + plus * cosine),
        b2: A * (plus + minus * cosine - slope), a0: plus - minus * cosine + slope,
        a1: 2 * (minus - plus * cosine), a2: plus - minus * cosine - slope});
    }
  }
  return result;
}
