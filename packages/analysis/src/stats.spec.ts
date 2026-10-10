import { describe, expect, it } from 'vitest';
import { analysisSettingsSchema, DEFAULT_SETTINGS, median, quantile, theilSenSlope } from './index';

describe('quantile / median', () => {
  it('uses linear interpolation (type 7)', () => {
    const s = [1, 2, 3, 4];
    expect(quantile(s, 0)).toBe(1);
    expect(quantile(s, 0.25)).toBe(1.75);
    expect(quantile(s, 0.5)).toBe(2.5);
    expect(quantile(s, 1)).toBe(4);
  });

  it('median sorts a copy and handles odd/even lengths', () => {
    const v = [5, 1, 3];
    expect(median(v)).toBe(3);
    expect(v).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('throws on empty input', () => {
    expect(() => quantile([], 0.5)).toThrow();
  });

  it('throws when p is outside [0, 1] or not finite', () => {
    const s = [1, 2, 3];
    expect(() => quantile(s, -0.1)).toThrow('quantile: p 0..1 aralığında olmalı');
    expect(() => quantile(s, 1.1)).toThrow('quantile: p 0..1 aralığında olmalı');
    expect(() => quantile(s, Number.NaN)).toThrow('quantile: p 0..1 aralığında olmalı');
    expect(() => quantile(s, Number.POSITIVE_INFINITY)).toThrow('quantile: p 0..1 aralığında olmalı');
  });
});

describe('theilSenSlope', () => {
  it('recovers a linear slope and resists one outlier', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 10_000, y: 1_300_000 - i * 10_000 }));
    pts[5] = { x: 50_000, y: 9_000_000 };
    expect(theilSenSlope(pts)).toBeCloseTo(-1, 6);
  });

  it('returns null when all x are equal or there are fewer than 2 points', () => {
    expect(theilSenSlope([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBeNull();
    expect(theilSenSlope([{ x: 1, y: 1 }])).toBeNull();
  });

  it('samples large inputs deterministically', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 1000 - 2 * i }));
    expect(theilSenSlope(pts)).toBe(-2);
    expect(theilSenSlope(pts)).toBe(theilSenSlope(pts));
  });

  it('uses only the sampled stride points for large inputs', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 1000 - 2 * i }));
    const sampled = new Set(Array.from({ length: 300 }, (_, k) => Math.floor((k * 1000) / 300)));
    for (let i = 0; i < pts.length; i++) {
      if (!sampled.has(i)) pts[i] = { x: i, y: 10_000_000 };
    }
    expect(theilSenSlope(pts)).toBe(-2);
  });

  it('is affected by outliers when no sampling happens (300 points)', () => {
    const pts = Array.from({ length: 300 }, (_, i) => ({ x: i, y: 1000 - 2 * i }));
    for (let i = 0; i < pts.length; i++) {
      if (i % 10 < 7) pts[i] = { x: i, y: 10_000_000 };
    }
    expect(theilSenSlope(pts)).not.toBe(-2);
  });
});

describe('analysis settings', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      minComparables: 5,
      yearAdjPct: 0.07,
      kmAdjPer10k: 0.02,
      maxAdjPct: 0.2,
      theilSenMinPool: 8,
      smallPoolMax: 7,
      dispersionThreshold: 0.25,
      suspiciousDiscount: 0.45,
      poolWindowDays: 60,
      refreshMinChangePct: 0.02,
    });
  });

  it('accepts partial overrides and rejects unknown keys / bad ranges', () => {
    expect(analysisSettingsSchema.parse({ minComparables: 3 }).minComparables).toBe(3);
    expect(analysisSettingsSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(analysisSettingsSchema.safeParse({ yearAdjPct: 2 }).success).toBe(false);
  });
});
