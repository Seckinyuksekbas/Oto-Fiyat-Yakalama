import { describe, expect, it } from 'vitest';
import { becameMoreMatchable, deriveEvent, isDamaged, isMatchEvent, materiallyChanged } from './events';

const t0 = new Date('2026-10-10T10:00:00Z');
const t1 = new Date('2026-10-10T12:00:00Z');
const latest = { createdAt: t0, listingPrice: 1000n, listingContentHash: 'h1' };

describe('deriveEvent', () => {
  it('NEW without a previous analysis', () => {
    expect(deriveEvent({ price: 1000n, contentHash: 'h1', relistedAt: null }, null)).toBe('NEW');
  });
  it('RELIST when relisted after the last analysis', () => {
    expect(deriveEvent({ price: 1000n, contentHash: 'h1', relistedAt: t1 }, latest)).toBe('RELIST');
    expect(deriveEvent({ price: 1000n, contentHash: 'h1', relistedAt: new Date(t0.getTime() - 1) }, latest)).toBe('REFRESH');
  });
  it('REFRESH on same hash, PRICE_DROP on lower price, CHANGE otherwise', () => {
    expect(deriveEvent({ price: 1000n, contentHash: 'h1', relistedAt: null }, latest)).toBe('REFRESH');
    expect(deriveEvent({ price: 900n, contentHash: 'h2', relistedAt: null }, latest)).toBe('PRICE_DROP');
    expect(deriveEvent({ price: 1100n, contentHash: 'h2', relistedAt: null }, latest)).toBe('CHANGE');
    expect(deriveEvent({ price: 900n, contentHash: 'h2', relistedAt: null }, { ...latest, listingPrice: null })).toBe('CHANGE');
  });
});

describe('isMatchEvent', () => {
  it('accepts only NEW, PRICE_DROP, RELIST', () => {
    expect(isMatchEvent('NEW')).toBe(true);
    expect(isMatchEvent('PRICE_DROP')).toBe(true);
    expect(isMatchEvent('RELIST')).toBe(true);
    expect(isMatchEvent('CHANGE')).toBe(false);
    expect(isMatchEvent('REFRESH')).toBe(false);
  });
});

describe('isDamaged', () => {
  it('tramer or changed parts only', () => {
    expect(isDamaged(null)).toBe(false);
    expect(isDamaged({ tramerAmount: 0, changedParts: [] })).toBe(false);
    expect(isDamaged({ paintedParts: ['kapi'] })).toBe(false);
    expect(isDamaged({ tramerAmount: 5000 })).toBe(true);
    expect(isDamaged({ changedParts: ['kaput'] })).toBe(true);
  });
});

describe('materiallyChanged', () => {
  const settings = { refreshMinChangePct: 0.02 } as never;
  const base = { engineVersion: 'v1', confidence: 'HIGH', estimatedPrice: 1_000_000n };
  const res = (over: object) => ({ engineVersion: 'v1', confidence: 'HIGH', estimatedPrice: 1_000_000n, ...over }) as never;
  it('detects version, confidence and above-threshold estimate change', () => {
    expect(materiallyChanged(base, res({}), settings)).toBe(false);
    expect(materiallyChanged(base, res({ engineVersion: 'v2' }), settings)).toBe(true);
    expect(materiallyChanged(base, res({ confidence: 'LOW' }), settings)).toBe(true);
    expect(materiallyChanged(base, res({ estimatedPrice: 1_010_000n }), settings)).toBe(false);
    expect(materiallyChanged(base, res({ estimatedPrice: 1_030_000n }), settings)).toBe(true);
    expect(materiallyChanged(base, res({ estimatedPrice: null }), settings)).toBe(true);
    expect(materiallyChanged({ ...base, estimatedPrice: null }, res({ estimatedPrice: null }), settings)).toBe(false);
  });
});

describe('becameMoreMatchable', () => {
  it('true when the confidence rank rises', () => {
    expect(becameMoreMatchable({ confidence: 'INSUFFICIENT', discountPct: null }, { confidence: 'LOW', discountPct: null })).toBe(true);
    expect(becameMoreMatchable({ confidence: 'LOW', discountPct: 0.2 }, { confidence: 'HIGH', discountPct: 0.1 })).toBe(true);
  });
  it('false when the confidence falls or stays and the discount does not improve', () => {
    expect(becameMoreMatchable({ confidence: 'HIGH', discountPct: 0.2 }, { confidence: 'LOW', discountPct: 0.2 })).toBe(false);
    expect(becameMoreMatchable({ confidence: 'HIGH', discountPct: 0.2 }, { confidence: 'HIGH', discountPct: 0.2 })).toBe(false);
    expect(becameMoreMatchable({ confidence: 'HIGH', discountPct: 0.2 }, { confidence: 'HIGH', discountPct: 0.15 })).toBe(false);
  });
  it('requires at least 1pp discount gain at equal confidence (Decimal-like latest accepted)', () => {
    expect(becameMoreMatchable({ confidence: 'MEDIUM', discountPct: { toString: () => '0.1000' } }, { confidence: 'MEDIUM', discountPct: 0.105 })).toBe(false);
    expect(becameMoreMatchable({ confidence: 'MEDIUM', discountPct: { toString: () => '0.1000' } }, { confidence: 'MEDIUM', discountPct: 0.11 })).toBe(true);
  });
  it('a first discount counts, but never for INSUFFICIENT or a null discount', () => {
    expect(becameMoreMatchable({ confidence: 'MEDIUM', discountPct: null }, { confidence: 'MEDIUM', discountPct: 0.1 })).toBe(true);
    expect(becameMoreMatchable({ confidence: 'INSUFFICIENT', discountPct: 0.1 }, { confidence: 'INSUFFICIENT', discountPct: 0.4 })).toBe(false);
    expect(becameMoreMatchable({ confidence: 'MEDIUM', discountPct: 0.1 }, { confidence: 'MEDIUM', discountPct: null })).toBe(false);
  });
});
