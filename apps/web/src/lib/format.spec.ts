import { describe, expect, it } from 'vitest';
import { bandGeometry, formatDateTime, formatDiscount, formatKm, formatRelative, formatShortTl, formatTl } from './format';

describe('format', () => {
  it('money, km, discount', () => {
    expect(formatTl('960000')).toBe('960.000 ₺');
    expect(formatTl(1250000n)).toBe('1.250.000 ₺');
    expect(formatKm(85000)).toBe('85.000 km');
    expect(formatDiscount(0.2)).toBe('%20 altında');
    expect(formatDiscount(-0.05)).toBe('%5 üstünde');
    expect(formatDiscount(null)).toBeNull();
  });
  it('short money', () => {
    expect(formatShortTl(1_200_000)).toBe('1,2 Mn ₺');
    expect(formatShortTl(960_000)).toBe('960 B ₺');
    expect(formatShortTl(1_000_000)).toBe('1 Mn ₺');
  });
  it('relative and Istanbul date time', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(formatRelative('2026-10-10T11:48:00Z', now)).toBe('12 dk önce');
    expect(formatRelative('2026-10-10T09:00:00Z', now)).toBe('3 sa önce');
    expect(formatRelative('2026-10-08T12:00:00Z', now)).toBe('2 gün önce');
    expect(formatDateTime('2026-10-10T11:32:00Z')).toBe('10.10.2026 14:32');
  });
  it('band geometry clamps the marker and handles missing stats', () => {
    const g = bandGeometry({ q1: 1_000_000, median: 1_200_000, q3: 1_400_000, price: 960_000 })!;
    expect(g.pos(1_200_000)).toBeGreaterThan(g.pos(1_000_000));
    expect(g.pos(960_000)).toBeGreaterThanOrEqual(0);
    expect(g.markerClamped).toBe(false);
    expect(g.min).toBe(864_000);

    const far = bandGeometry({ q1: 1_000_000, median: 1_200_000, q3: 1_400_000, price: 50_000 })!;
    expect(far.min).toBe(500_000);
    expect(far.pos(50_000)).toBe(0);
    expect(far.markerClamped).toBe(true);

    const high = bandGeometry({ q1: 1_000_000, median: 1_200_000, q3: 1_400_000, price: 9_000_000 })!;
    expect(high.max).toBe(2_100_000);
    expect(high.pos(9_000_000)).toBe(100);
    expect(high.markerClamped).toBe(true);

    expect(bandGeometry({ q1: null, median: null, q3: null, price: 1 })).toBeNull();
    expect(bandGeometry({ q1: 0, median: 0, q3: 0, price: 1 })).toBeNull();
  });
});
