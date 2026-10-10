import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_SETTINGS, type AnalysisTarget, type Comparable } from './index';

const target = (over: Partial<AnalysisTarget> = {}): AnalysisTarget => ({
  id: 1, trim: '320i', year: 2019, km: 85_000, price: 960_000n, damaged: false, hadPriceDrop: false, ...over,
});

let seq = 100;
const comp = (over: Partial<Comparable> = {}): Comparable => {
  seq += 1;
  return { id: seq, title: `İlan ${seq}`, trim: '318i', year: 2019, km: 85_000, price: 1_200_000n, damaged: false, ...over };
};
const prices = (list: number[], over: Partial<Comparable> = {}) => list.map((p) => comp({ price: BigInt(p), ...over }));

describe('analyze — spec §4.8 reference example', () => {
  it('14 comparables at L1, 20% below → HIGH, score 77', () => {
    const pool = prices([1_110_000, 1_120_000, 1_130_000, 1_140_000, 1_150_000, 1_170_000, 1_190_000, 1_210_000, 1_230_000, 1_250_000, 1_260_000, 1_270_000, 1_280_000, 1_290_000]);
    const r = analyze(target(), pool);
    expect(r.engineVersion).toBe('rules-v1');
    expect(r.estimatedPrice).toBe(1_200_000n);
    expect(r.priceDiff).toBe(240_000n);
    expect(r.discountPct).toBe(0.2);
    expect(r.expansionLevel).toBe(1);
    expect(r.comparableCount).toBe(14);
    expect(r.confidence).toBe('HIGH');
    expect(r.flags).toEqual([]);
    expect(r.opportunityScore).toBe(77);
    expect(r.explanation.stats.dispersion).toBeLessThan(0.25);
    expect(r.comparableIds).toEqual([...r.comparableIds].sort((a, b) => a - b));
  });

  it('adds the price-drop bonus only when the listing is below market', () => {
    const pool = prices(Array.from({ length: 10 }, () => 1_200_000).map((p, i) => p + i * 1000));
    expect(analyze(target({ hadPriceDrop: true }), pool).opportunityScore).toBe(analyze(target(), pool).opportunityScore + 5);
    expect(analyze(target({ hadPriceDrop: true, price: 2_000_000n }), pool).opportunityScore).toBe(analyze(target({ price: 2_000_000n }), pool).opportunityScore);
  });
});

describe('analyze — pool expansion', () => {
  it('prefers L0 (same year, same trim)', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000, 1_205_000, 1_195_000, 1_200_000, 1_202_000, 1_198_000], { trim: '320i' }));
    expect(r.expansionLevel).toBe(0);
    expect(r.confidence).toBe('HIGH');
  });

  it('treats a whitespace-only target trim as no trim', () => {
    const r = analyze(target({ trim: '   ' }), prices(Array.from({ length: 8 }, (_, i) => 1_200_000 + i * 1000)));
    expect(r.expansionLevel).toBe(0);
    expect(r.comparableCount).toBe(8);
  });

  it('ignores trim at L0 when the target has none', () => {
    const r = analyze(target({ trim: null }), prices(Array.from({ length: 8 }, (_, i) => 1_200_000 + i * 1000)));
    expect(r.expansionLevel).toBe(0);
  });

  it('caps confidence by level: L2 → MEDIUM, L3 → LOW', () => {
    const l2 = analyze(target(), prices(Array.from({ length: 9 }, (_, i) => 1_000_000 + i * 1000), { year: 2017 }));
    expect(l2.expansionLevel).toBe(2);
    expect(l2.confidence).toBe('MEDIUM');
    const l3 = analyze(target(), prices(Array.from({ length: 9 }, (_, i) => 1_000_000 + i * 1000), { year: 2016 }));
    expect(l3.expansionLevel).toBe(3);
    expect(l3.confidence).toBe('LOW');
  });

  it('uses km windows relative to max(target km, 10.000)', () => {
    // 0 km hedef: L3 penceresi 0,6 × 10.000 = 6.000 km → 7.000 km'lik emsaller hiçbir seviyeye girmez, 5.000 km'likler L2'ye (4.000) girmez, L3'e girer
    const far = prices(Array.from({ length: 5 }, () => 1_000_000), { km: 7_000 });
    expect(analyze(target({ km: 0 }), far)).toMatchObject({ confidence: 'INSUFFICIENT', comparableCount: 0 });
    const mid = prices(Array.from({ length: 5 }, () => 1_000_000), { km: 5_000 });
    expect(analyze(target({ km: 0 }), mid).expansionLevel).toBe(3);
  });
});

describe('analyze — sparse markets (Review Focus #1)', () => {
  it('fewer than 5 comparables → INSUFFICIENT, no confidence points', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000]));
    expect(r.confidence).toBe('INSUFFICIENT');
    expect(r.estimatedPrice).toBe(1_200_000n);
    expect(r.opportunityScore).toBe(Math.round((0.2 / 0.3) * 70));
    expect(r.explanation.insufficient).toBe(true);
  });

  it('no comparables → null estimate, score 0 even with a price drop', () => {
    const r = analyze(target({ hadPriceDrop: true }), []);
    expect(r).toMatchObject({ estimatedPrice: null, priceDiff: null, discountPct: null, opportunityScore: 0, comparableCount: 0, confidence: 'INSUFFICIENT' });
  });

  it('respects a minComparables override', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000], { trim: '320i' }), { ...DEFAULT_SETTINGS, minComparables: 3 });
    expect(r.confidence).toBe('MEDIUM'); // 3 ≤ smallPoolMax
  });
});

describe('analyze — robustness (Review Focus #2)', () => {
  it('drops a 10x typo via IQR and reports it', () => {
    const pool = prices(Array.from({ length: 10 }, (_, i) => 1_180_000 + i * 5000));
    const typo = comp({ price: 12_000_000n });
    const r = analyze(target(), [...pool, typo]);
    expect(r.explanation.pool.outlierIds).toContain(typo.id);
    expect(r.comparableIds).not.toContain(typo.id);
    expect(Number(r.estimatedPrice)).toBeGreaterThan(1_180_000);
    expect(Number(r.estimatedPrice)).toBeLessThan(1_230_000);
  });

  it('counts duplicate reposts (same title, price, km) once', () => {
    const dup = Array.from({ length: 6 }, () => comp({ title: 'Aynı ilan', price: 1_000_000n }));
    const r = analyze(target(), [...dup, ...prices([1_200_000, 1_210_000, 1_190_000, 1_205_000])]);
    expect(r.explanation.pool.afterDedup).toBe(5);
  });

  it('clamps total adjustment to ±20% of the comparable price', () => {
    const r = analyze(target(), prices(Array.from({ length: 5 }, () => 1_000_000), { year: 2016 }));
    expect(r.estimatedPrice).toBe(1_200_000n); // 1.07^3 = 1.225 → %20'ye kırpılır
  });

  it('clamps an absurd negative discount into the DB range', () => {
    const r = analyze(target({ price: 50_000_000n }), prices(Array.from({ length: 6 }, () => 60_000)));
    expect(r.discountPct).toBe(-99.9999);
  });
});

describe('analyze — adjustments', () => {
  it('year: a one-year-older comparable is worth 7% more for the target', () => {
    const r = analyze(target(), prices(Array.from({ length: 5 }, () => 1_000_000), { year: 2018 }));
    expect(r.estimatedPrice).toBe(1_070_000n);
  });

  it('km default: 2% per 10.000 km when the pool is small', () => {
    const r = analyze(target({ km: 60_000 }), prices(Array.from({ length: 5 }, () => 1_200_000), { km: 80_000, trim: '320i' }));
    expect(r.explanation.adjustments.kmMethod).toBe('DEFAULT');
    expect(r.estimatedPrice).toBe(1_248_000n);
  });

  it('km Theil–Sen when the pool has ≥ 8 points', () => {
    const pool = Array.from({ length: 12 }, (_, i) => {
      const km = 70_000 + i * 5000;
      return comp({ km, price: BigInt(1_300_000 - km), trim: '320i' });
    });
    const r = analyze(target({ km: 100_000 }), pool);
    expect(r.explanation.adjustments.kmMethod).toBe('THEIL_SEN');
    expect(r.explanation.adjustments.kmSlopePerKm).toBeCloseTo(-1, 6);
    expect(r.estimatedPrice).toBe(1_200_000n);
  });

  it('falls back to the default when the fitted slope is not negative', () => {
    const pool = Array.from({ length: 10 }, (_, i) => comp({ km: 70_000 + i * 5000, price: BigInt(1_000_000 + i * 10_000), trim: '320i' }));
    expect(analyze(target({ km: 90_000 }), pool).explanation.adjustments.kmMethod).toBe('DEFAULT');
  });
});

describe('analyze — confidence and flags (Review Focus #3)', () => {
  it('5–7 comparables cap at MEDIUM', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000, 1_205_000, 1_195_000, 1_200_000], { trim: '320i' }));
    expect(r.confidence).toBe('MEDIUM');
  });

  it('high dispersion downgrades and flags', () => {
    const r = analyze(target(), prices([800_000, 900_000, 1_000_000, 1_100_000, 1_300_000, 1_400_000, 1_500_000, 1_600_000, 1_200_000, 1_250_000], { trim: '320i' }));
    expect(r.flags).toContain('HIGH_DISPERSION');
    expect(r.confidence).toBe('MEDIUM');
  });

  it('a damaged target is flagged and downgraded', () => {
    const pool = prices(Array.from({ length: 10 }, (_, i) => 1_195_000 + i * 1000), { trim: '320i' });
    const r = analyze(target({ damaged: true }), pool);
    expect(r.flags).toContain('DAMAGED');
    expect(r.confidence).toBe('MEDIUM');
  });

  it('excludes damaged comparables for a clean target when enough clean ones remain', () => {
    const clean = prices(Array.from({ length: 6 }, (_, i) => 1_200_000 + i * 1000), { trim: '320i' });
    const damaged = prices([800_000, 810_000, 820_000], { trim: '320i', damaged: true });
    const r = analyze(target(), [...clean, ...damaged]);
    expect(r.explanation.pool.damagedExcluded).toBe(3);
    expect(r.comparableIds.some((id) => damaged.some((d) => d.id === id))).toBe(false);
  });

  it('keeps damaged comparables when clean ones are too few', () => {
    const clean = prices([1_200_000, 1_210_000, 1_190_000], { trim: '320i' });
    const damaged = prices([1_100_000, 1_110_000, 1_120_000], { trim: '320i', damaged: true });
    expect(analyze(target(), [...clean, ...damaged]).explanation.pool.damagedExcluded).toBe(0);
  });

  it('a suspiciously cheap listing is capped at LOW', () => {
    const r = analyze(target({ price: 600_000n }), prices(Array.from({ length: 10 }, (_, i) => 1_195_000 + i * 1000), { trim: '320i' }));
    expect(r.flags).toContain('SUSPICIOUS_LOW');
    expect(r.confidence).toBe('LOW');
    expect(r.opportunityScore).toBe(50); // 70 + 6 = 76, capped at 50 for SUSPICIOUS_LOW
  });
});

describe('analyze — explanation', () => {
  it('records the inputs needed to explain the estimate', () => {
    const r = analyze(target(), prices(Array.from({ length: 10 }, (_, i) => 1_195_000 + i * 1000), { trim: '320i' }));
    expect(r.explanation).toMatchObject({
      engineVersion: 'rules-v1',
      level: 0,
      insufficient: false,
      pool: { candidates: 10, afterDedup: 10, inLevel: 10, damagedExcluded: 0, used: 10, outlierIds: [] },
      adjustments: { yearAdjPct: 0.07, kmAdjPer10k: 0.02, maxAdjPct: 0.2 },
      settings: DEFAULT_SETTINGS,
    });
    expect(r.explanation.stats.median).toBe(Number(r.estimatedPrice));
  });

  it('never uses the target itself as a comparable', () => {
    const self = comp({ id: 1, trim: '320i', price: 1_200_000n });
    const r = analyze(target(), [self, ...prices(Array.from({ length: 5 }, () => 1_200_000), { trim: '320i' })]);
    expect(r.comparableIds).not.toContain(1);
    expect(r.explanation.pool.afterDedup).toBe(5);
  });
});

describe('analyze — fix round 1', () => {
  const good = (n: number, over: Partial<Comparable> = {}) => prices(Array.from({ length: n }, (_, i) => 1_200_000 + i * 1000), over);

  it('expands the level when the pool is too small after outlier removal', () => {
    const l0 = [...good(4, { trim: '320i' }), comp({ trim: '320i', price: 12_000_000n })];
    const l1 = good(10, { trim: '318i' });
    const r = analyze(target(), [...l0, ...l1]);
    expect(r.expansionLevel).toBe(1);
    expect(r.confidence).not.toBe('INSUFFICIENT');
    expect(r.explanation.insufficientReason).toBe('NONE');
  });

  it('is INSUFFICIENT / AFTER_OUTLIERS when no level qualifies after IQR', () => {
    const r = analyze(target(), [...good(4, { trim: '320i' }), comp({ trim: '320i', price: 12_000_000n })]);
    expect(r.confidence).toBe('INSUFFICIENT');
    expect(r.explanation.insufficientReason).toBe('AFTER_OUTLIERS');
    expect(r.comparableCount).toBe(4);
  });

  it('reports NO_LEVEL when there are simply too few comparables', () => {
    expect(analyze(target(), good(3)).explanation.insufficientReason).toBe('NO_LEVEL');
  });

  it('prefers a wider clean level over a narrow level that needs damaged comparables', () => {
    const l0 = [...good(4, { trim: '320i' }), ...prices([1_100_000, 1_110_000], { trim: '320i', damaged: true })];
    const l1 = good(10, { trim: '318i' });
    const r = analyze(target(), [...l0, ...l1]);
    expect(r.expansionLevel).toBe(1);
    const dmgIds = l0.filter((c) => c.damaged).map((c) => c.id);
    expect(r.comparableIds.some((id) => dmgIds.includes(id))).toBe(false);
  });

  it('caps the score at 50 for INSUFFICIENT and SUSPICIOUS_LOW', () => {
    const a = analyze(target({ price: 900_000n, hadPriceDrop: true }), prices([1_200_000, 1_200_000, 1_200_000].map((p, i) => p + i)));
    expect(a.confidence).toBe('INSUFFICIENT');
    expect(a.opportunityScore).toBeLessThanOrEqual(50);
    const b = analyze(target({ price: 600_000n }), good(10, { trim: '320i' }));
    expect(b.opportunityScore).toBe(50);
  });

  it('an invalid target price is INSUFFICIENT with score 0', () => {
    const r = analyze(target({ price: 0n }), good(10, { trim: '320i' }));
    expect(r).toMatchObject({ confidence: 'INSUFFICIENT', discountPct: null, priceDiff: null, opportunityScore: 0 });
    expect(r.explanation.insufficientReason).toBe('INVALID_TARGET');
  });

  it('ignores zero-price comparables and counts them', () => {
    const r = analyze(target(), [...good(6, { trim: '320i' }), ...prices([0, 0], { trim: '320i' })]);
    expect(r.explanation.pool.invalidPrice).toBe(2);
    expect(r.explanation.pool.afterDedup).toBe(6);
    expect(r.explanation.pool.candidates).toBe(8);
  });

  it('does not drop near-identical values when the IQR is ~0', () => {
    const r = analyze(target(), prices([1_200_000, 1_200_000, 1_200_000, 1_200_000, 1_200_000, 1_210_000], { trim: '320i' }));
    expect(r.explanation.pool.outlierIds).toEqual([]);
    expect(r.comparableCount).toBe(6);
  });

  it('clamps downward too (newer comparables)', () => {
    const pool = prices(Array.from({ length: 5 }, () => 1_000_000), { year: 2022 });
    const r = analyze(target(), pool);
    expect(r.estimatedPrice).toBe(816_298n); // 1_000_000 / 1.07^3 = 816_297.9 (> 0.8 floor, no clamp)
    const r2 = analyze(target(), pool, { ...DEFAULT_SETTINGS, maxAdjPct: 0.1 });
    expect(r2.estimatedPrice).toBe(900_000n);
    expect(r2.explanation.comparables.every((c) => c.clamped)).toBe(true);
  });

  it('combines dispersion and damaged downgrades', () => {
    const r = analyze(target({ damaged: true }), prices([800_000, 900_000, 1_000_000, 1_100_000, 1_300_000, 1_400_000, 1_500_000, 1_600_000, 1_200_000, 1_250_000], { trim: '320i' }));
    expect(r.confidence).toBe('LOW');
    expect(r.flags).toEqual(expect.arrayContaining(['HIGH_DISPERSION', 'DAMAGED']));
    expect(r.explanation.confidenceSteps).toEqual(['level-cap:HIGH', 'dispersion:-1', 'damaged:-1']);
  });

  it('explains every comparable and each confidence rule', () => {
    const typo = comp({ price: 12_000_000n });
    const r = analyze(target(), [...good(10), typo]);
    expect(r.explanation.comparables).toHaveLength(r.explanation.pool.used + r.explanation.pool.outlierIds.length);
    expect(r.explanation.comparables.find((c) => c.id === typo.id)?.outlier).toBe(true);
    expect(r.explanation.target).toEqual({ price: 960_000, year: 2019, km: 85_000, trim: '320i', damaged: false });
    const ref = analyze(target(), prices([1_110_000, 1_120_000, 1_130_000, 1_140_000, 1_150_000, 1_170_000, 1_190_000, 1_210_000, 1_230_000, 1_250_000, 1_260_000, 1_270_000, 1_280_000, 1_290_000]));
    expect(ref.explanation.confidenceSteps).toEqual(['level-cap:HIGH']);
  });

  it('copies settings instead of aliasing them', () => {
    const r = analyze(target(), good(6, { trim: '320i' }));
    expect(r.explanation.settings).not.toBe(DEFAULT_SETTINGS);
    expect(r.explanation.settings).toEqual(DEFAULT_SETTINGS);
  });
});
