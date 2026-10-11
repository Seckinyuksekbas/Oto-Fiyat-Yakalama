import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  decodeCursor,
  encodeCursor,
  listingCardSchema,
  opportunitiesQuerySchema,
  putFavoriteSchema,
} from './index';

describe('panel contracts', () => {
  it('opportunities query defaults and bounds', () => {
    expect(opportunitiesQuerySchema.parse({})).toMatchObject({ sort: 'score', limit: 24 });
    expect(opportunitiesQuerySchema.safeParse({ minScore: '59' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ confidence: 'LOW' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ maxPrice: '1.5' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ foo: '1' }).success).toBe(false);
  });
  it('cursor round-trips and rejects garbage', () => {
    const s = z.object({ score: z.number(), id: z.number() });
    const c = encodeCursor({ score: 77, id: 12 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, s)).toEqual({ score: 77, id: 12 });
    expect(decodeCursor('!!!', s)).toBeNull();
    expect(decodeCursor(encodeCursor({ score: 'x' }), s)).toBeNull();
  });
  it('favorite note is trimmed and bounded', () => {
    expect(putFavoriteSchema.parse({ note: '  güzel  ' })).toEqual({ note: 'güzel' });
    expect(putFavoriteSchema.safeParse({ note: 'x'.repeat(281) }).success).toBe(false);
    expect(putFavoriteSchema.parse({})).toEqual({});
  });
  it('listing card requires money strings', () => {
    const card = {
      id: 1, title: 't', make: 'BMW', model: '3', trim: null, year: 2019, km: 1, fuel: 'GASOLINE', transmission: 'AUTOMATIC',
      city: null, price: '960000', imageUrl: null, url: 'https://x', status: 'ACTIVE', firstSeenAt: '2026-10-10T00:00:00.000Z',
      analysis: null, isFavorite: false,
    };
    expect(listingCardSchema.parse(card)).toEqual(card);
    expect(listingCardSchema.safeParse({ ...card, price: 960000 }).success).toBe(false);
  });
});
