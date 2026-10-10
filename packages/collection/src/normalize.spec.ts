import { describe, expect, it } from 'vitest';
import {
  contentHash,
  createAliasResolver,
  normalizeListing,
  parseFuel,
  parseInteger,
  parseTransmission,
  type RawListing,
} from './index';

const resolve = createAliasResolver([
  { rawText: 'BMW 3 Serisi', make: 'BMW', model: '3 Serisi', trim: null },
  { rawText: 'BMW 3 Serisi 320i M Sport', make: 'BMW', model: '3 Serisi', trim: '320i M Sport' },
  { rawText: 'Mercedes-Benz C Serisi', make: 'Mercedes-Benz', model: 'C Serisi', trim: null },
]);

const NOW = new Date('2026-10-11T12:00:00Z');

const raw = (over: Partial<RawListing> = {}): RawListing => ({
  externalId: 'A1',
  url: 'https://demo.example/ilan/A1',
  title: '2019 BMW 3 Serisi 320i',
  makeModelText: 'BMW 3 Serisi 320i',
  year: '2019',
  km: '85.000 km',
  price: '960.000 TL',
  fuel: 'Benzin',
  transmission: 'Otomatik',
  city: 'İstanbul',
  ...over,
});

describe('parseInteger', () => {
  it.each([
    ['1.250.000 TL', 1_250_000],
    ['1.250.000,00 TL', 1_250_000],
    ['1.250.000,5 TL', 1_250_000],
    ['₺1,250,000', 1_250_000],
    ['85.000 km', 85_000],
    ['1250000', 1_250_000],
    [960000, 960_000],
    ['9600.50 TL', 9600],
    ['12.5', 12],
    ['1.250', 1250],
    ['85,000', 85_000],
  ])('%s → %d', (input, expected) => {
    expect(parseInteger(input)).toBe(expected);
  });

  it.each([
    '',
    'yok',
    '12345678901234',
    12.5,
    '-85.000 km',
    '1e6',
    '2019 - 2020',
    '1.250.000,00 TL (KDV 20%)',
    undefined,
    null,
    {},
  ])('rejects %s', (input) => {
    expect(parseInteger(input)).toBeNull();
  });
});

describe('fuel / transmission', () => {
  it('maps Turkish labels case-insensitively (Turkish locale)', () => {
    expect(parseFuel('BENZİN')).toBe('GASOLINE');
    expect(parseFuel('Benzin & LPG')).toBe('LPG');
    expect(parseFuel('Hibrit')).toBe('HYBRID');
    expect(parseFuel('Hidrojen')).toBe('OTHER');
    expect(parseTransmission('OTOMATİK')).toBe('AUTOMATIC');
    expect(parseTransmission('Yarı Otomatik')).toBe('SEMI_AUTOMATIC');
    expect(parseTransmission('Düz')).toBe('MANUAL');
    expect(parseTransmission('CVT?')).toBeNull();
  });

  it('maps ASCII-uppercase Turkish labels (dotless ı)', () => {
    expect(parseFuel('BENZIN')).toBe('GASOLINE');
    expect(parseFuel('DIZEL')).toBe('DIESEL');
    expect(parseTransmission('OTOMATIK')).toBe('AUTOMATIC');
    expect(parseTransmission('YARI OTOMATIK')).toBe('SEMI_AUTOMATIC');
  });
});

describe('createAliasResolver', () => {
  it('uses the longest matching alias and keeps the remainder as trim', () => {
    expect(resolve('BMW 3 Serisi 320i M Sport')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '320i M Sport' });
    expect(resolve('bmw  3 serisi 318i')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '318i' });
    expect(resolve('BMW 3 Serisi')).toEqual({ make: 'BMW', model: '3 Serisi', trim: null });
  });

  it('matches ASCII-uppercase input and keeps the original trim case', () => {
    expect(resolve('BMW 3 SERISI 320I')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '320I' });
  });

  it('does not match a prefix in the middle of a word', () => {
    expect(resolve('BMW 3 Serisix 320i')).toBeNull();
    expect(resolve('Tesla Model 3')).toBeNull();
  });
});

describe('normalizeListing', () => {
  it('normalizes a valid listing', () => {
    const r = normalizeListing(raw({ damage: { tramerAmount: '12.500 TL', paintedParts: [' Kaput '], changedParts: [] } }), resolve, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listing).toMatchObject({
      externalId: 'A1',
      make: 'BMW',
      model: '3 Serisi',
      trim: '320i',
      year: 2019,
      km: 85_000,
      price: 960_000n,
      currency: 'TRY',
      fuel: 'GASOLINE',
      transmission: 'AUTOMATIC',
      city: 'İstanbul',
      damageInfo: { tramerAmount: 12_500, paintedParts: ['Kaput'], changedParts: [] },
    });
    expect(r.listing.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('collects every problem instead of stopping at the first', () => {
    const r = normalizeListing(
      raw({ makeModelText: 'Tesla Model 3', year: '1975', km: '2.000.000 km', price: '10 TL', transmission: '?', url: 'ftp://x' }),
      resolve,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field).sort()).toEqual(['km', 'makeModel', 'price', 'transmission', 'url', 'year']);
    expect(r.problems.every((p) => p.externalId === 'A1')).toBe(true);
  });

  it('accepts next model year but not the one after', () => {
    expect(normalizeListing(raw({ year: 2027 }), resolve, NOW).ok).toBe(true);
    expect(normalizeListing(raw({ year: 2028 }), resolve, NOW).ok).toBe(false);
  });

  it('reports a problem instead of throwing when year/km/price are undefined', () => {
    const r = normalizeListing(raw({ year: undefined as never, km: undefined as never, price: undefined as never }), resolve, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field).sort()).toEqual(['km', 'price', 'year']);
  });

  it('drops empty damage info and non-http image URLs', () => {
    const r = normalizeListing(raw({ damage: { tramerAmount: '', paintedParts: [], changedParts: [] }, imageUrl: 'javascript:alert(1)' }), resolve, NOW);
    expect(r.ok && r.listing.damageInfo).toBeNull();
    expect(r.ok && r.listing.imageUrl).toBeNull();
  });
});

describe('contentHash', () => {
  it('is stable and changes when a field changes', () => {
    const a = normalizeListing(raw(), resolve, NOW);
    const b = normalizeListing(raw(), resolve, NOW);
    const c = normalizeListing(raw({ price: '950.000 TL' }), resolve, NOW);
    if (!a.ok || !b.ok || !c.ok) throw new Error('unexpected');
    expect(a.listing.contentHash).toBe(b.listing.contentHash);
    expect(a.listing.contentHash).not.toBe(c.listing.contentHash);
    const { contentHash: _h, ...rest } = a.listing;
    expect(contentHash(rest)).toBe(a.listing.contentHash);
  });

  it('ignores object key order', () => {
    const a = normalizeListing(raw(), resolve, NOW);
    if (!a.ok) throw new Error('unexpected');
    const { contentHash: _h, ...rest } = a.listing;
    const reordered = Object.fromEntries(Object.entries(rest).reverse()) as typeof rest;
    expect(contentHash(reordered)).toBe(a.listing.contentHash);
  });
});
