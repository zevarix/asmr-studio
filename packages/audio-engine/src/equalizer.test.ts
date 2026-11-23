import {describe, expect, it} from 'vitest';
import {flatEqualizer, SceneValidationError} from '@asmr-studio/contracts';
import {EQ_BANDS, equalizerCoefficients, type BiquadCoefficients} from './equalizer.js';

/** Evaluate the transfer function independently of the coefficient construction. */
function response(coefficients: BiquadCoefficients[], frequency: number, sampleRate = 48_000) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  let real = 1; let imaginary = 0;
  for (const {a0, a1, a2, b0, b1, b2} of coefficients) {
    const nr = b0 + b1 * Math.cos(omega) + b2 * Math.cos(2 * omega);
    const ni = -b1 * Math.sin(omega) - b2 * Math.sin(2 * omega);
    const dr = a0 + a1 * Math.cos(omega) + a2 * Math.cos(2 * omega);
    const di = -a1 * Math.sin(omega) - a2 * Math.sin(2 * omega);
    const denominator = dr * dr + di * di;
    const r = (nr * dr + ni * di) / denominator;
    const i = (ni * dr - nr * di) / denominator;
    [real, imaginary] = [real * r - imaginary * i, real * i + imaginary * r];
  }
  return {real, imaginary, magnitude: Math.hypot(real, imaginary)};
}

describe('shared Web Audio equalizer coefficients', () => {
  it('defines the agreed fixed bands and omits identity processing for old, flat, and bypassed recipes', () => {
    expect(EQ_BANDS).toEqual([{key: 'bassDb', type: 'lowshelf', frequency: 200},
      {key: 'midDb', type: 'peaking', frequency: 1000, Q: Math.SQRT1_2},
      {key: 'trebleDb', type: 'highshelf', frequency: 4000}]);
    expect(equalizerCoefficients(undefined, 48_000)).toEqual([]);
    expect(equalizerCoefficients(flatEqualizer(), 48_000)).toEqual([]);
    expect(equalizerCoefficients({bassDb: 12, midDb: -12, trebleDb: 6, bypassed: true}, 48_000)).toEqual([]);
    expect(equalizerCoefficients({...flatEqualizer(), bassDb: 4, trebleDb: -2}, 48_000)).toHaveLength(2);
  });

  it.each([-12, 6, 12])('gives a %s dB bass shelf with the expected DC, corner, and Nyquist gains', gain => {
    const coefficients = equalizerCoefficients({...flatEqualizer(), bassDb: gain}, 48_000);
    expect(response(coefficients, 0).magnitude).toBeCloseTo(10 ** (gain / 20), 9);
    expect(response(coefficients, 200).magnitude).toBeCloseTo(10 ** (gain / 40), 9);
    expect(response(coefficients, 24_000).magnitude).toBeCloseTo(1, 12);
  });

  it.each([-12, 6, 12])('gives a %s dB mid peak with unity outside the band', gain => {
    const coefficients = equalizerCoefficients({...flatEqualizer(), midDb: gain}, 48_000);
    expect(response(coefficients, 0).magnitude).toBeCloseTo(1, 12);
    expect(response(coefficients, 1000).magnitude).toBeCloseTo(10 ** (gain / 20), 11);
    expect(response(coefficients, 24_000).magnitude).toBeCloseTo(1, 12);
  });

  it.each([-12, 6, 12])('gives a %s dB treble shelf with the expected corner and endpoint gains', gain => {
    const coefficients = equalizerCoefficients({...flatEqualizer(), trebleDb: gain}, 48_000);
    expect(response(coefficients, 0).magnitude).toBeCloseTo(1, 12);
    expect(response(coefficients, 4000).magnitude).toBeCloseTo(10 ** (gain / 40), 11);
    expect(response(coefficients, 24_000).magnitude).toBeCloseTo(10 ** (gain / 20), 11);
  });

  it('makes opposite boosts and cuts cancel in magnitude and phase across supported playback rates', () => {
    for (const sampleRate of [32_000, 44_100, 48_000, 96_000]) {
      const boost = equalizerCoefficients({bassDb: 9, midDb: -6, trebleDb: 3, bypassed: false}, sampleRate);
      const cut = equalizerCoefficients({bassDb: -9, midDb: 6, trebleDb: -3, bypassed: false}, sampleRate);
      for (const frequency of [0, 50, 200, 1000, 4000, sampleRate / 2]) {
        const value = response([...boost, ...cut], frequency, sampleRate);
        expect(value.real).toBeCloseTo(1, 9); expect(value.imaginary).toBeCloseTo(0, 9);
      }
    }
  });

  it('keeps fixed-filter poles stable and silent input exactly silent at both gain extremes', () => {
    for (const sampleRate of [8000, 44_100, 48_000, 96_000, 192_000]) for (const gain of [-12, 12]) {
      const coefficients = equalizerCoefficients({bassDb: gain, midDb: gain, trebleDb: gain, bypassed: false}, sampleRate);
      for (const c of coefficients) {
        expect(Object.values(c).every(Number.isFinite)).toBe(true);
        const p = c.a1 / c.a0; const q = c.a2 / c.a0; const discriminant = p * p - 4 * q;
        const radius = discriminant < 0 ? Math.sqrt(q)
          : Math.max(Math.abs((-p + Math.sqrt(discriminant)) / 2), Math.abs((-p - Math.sqrt(discriminant)) / 2));
        expect(radius).toBeLessThan(1);
        let y1 = 0; let y2 = 0;
        for (let frame = 0; frame < 128; frame++) {
          const output = (-c.a1 * y1 - c.a2 * y2) / c.a0;
          expect(Math.abs(output)).toBe(0); y2 = y1; y1 = output;
        }
      }
    }
  });

  it('uses native Nyquist limits instead of unstable pole cancellation at low sample rates', () => {
    expect(equalizerCoefficients({...flatEqualizer(), trebleDb: 12}, 8000)).toEqual([]);
    expect(equalizerCoefficients({...flatEqualizer(), midDb: 12}, 2000)).toEqual([]);
    expect(equalizerCoefficients({...flatEqualizer(), bassDb: 6}, 400))
      .toEqual([{a0: 1, a1: 0, a2: 0, b0: 10 ** (6 / 20), b1: 0, b2: 0}]);
  });

  it('rejects invalid sample rates and invalid settings even when bypass is requested', () => {
    for (const rate of [0, -1, NaN, Infinity]) expect(() => equalizerCoefficients(flatEqualizer(), rate)).toThrow(SceneValidationError);
    for (const settings of [{...flatEqualizer(), bassDb: 13}, {...flatEqualizer(), midDb: NaN, bypassed: true},
      {...flatEqualizer(), unexpected: 1}]) expect(() => equalizerCoefficients(settings, 48_000)).toThrow(SceneValidationError);
  });
});
