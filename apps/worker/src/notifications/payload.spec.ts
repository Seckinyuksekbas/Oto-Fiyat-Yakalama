import type { Listing, ListingAnalysis } from '@oto/db';
import { describe, expect, it } from 'vitest';
import { buildMatchPayload } from './payload';

const listing = {
  id: 1, title: 't', make: 'BMW', model: '3', trim: null, year: 2019, km: 1, fuel: 'GASOLINE', transmission: 'AUTOMATIC', city: null,
  price: 100n, imageUrl: null, url: 'http://x', firstSeenAt: new Date('2026-10-10T10:00:00Z'),
} as unknown as Listing;
const analysis = {
  listingPrice: 90n, opportunityScore: 50, confidence: 'HIGH', estimatedPrice: null, priceDiff: null, discountPct: null, comparableCount: 3,
  createdAt: new Date('2026-10-11T09:00:00Z'),
} as unknown as ListingAnalysis;
const base = { listing, analysis, previousPrice: null, profile: { id: 'p', name: 'n' }, limitExceeded: false };

describe('buildMatchPayload eventAt', () => {
  it('uses listing.firstSeenAt for NEW', () => {
    expect(buildMatchPayload({ ...base, reason: 'NEW' }).eventAt).toBe('2026-10-10T10:00:00.000Z');
  });
  it('uses the analysis createdAt for PRICE_DROP and RELIST', () => {
    expect(buildMatchPayload({ ...base, reason: 'PRICE_DROP' }).eventAt).toBe('2026-10-11T09:00:00.000Z');
    expect(buildMatchPayload({ ...base, reason: 'RELIST' }).eventAt).toBe('2026-10-11T09:00:00.000Z');
  });
});

describe('buildMatchPayload promoted NEW', () => {
  it('uses analysis createdAt when the NEW is not from the first analysis', () => {
    expect(buildMatchPayload({ ...base, reason: 'NEW', firstAnalysis: false }).eventAt).toBe('2026-10-11T09:00:00.000Z');
    expect(buildMatchPayload({ ...base, reason: 'NEW', firstAnalysis: true }).eventAt).toBe('2026-10-10T10:00:00.000Z');
  });
});
