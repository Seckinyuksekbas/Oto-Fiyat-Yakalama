import { createHash } from 'node:crypto';
import type { DamageInfo, Fuel, ListingProblem, NormalizedListing, RawListing, Transmission } from './types';

export interface MakeModel {
  make: string;
  model: string;
  trim: string | null;
}
export type MakeModelResolver = (text: string) => MakeModel | null;
export interface AliasRow {
  rawText: string;
  make: string;
  model: string;
  trim: string | null;
}

export const LIMITS = { minYear: 1980, minKm: 0, maxKm: 1_500_000, minPrice: 50_000, maxPrice: 50_000_000 } as const;

const FUELS: Record<string, Fuel> = {
  benzin: 'GASOLINE',
  dizel: 'DIESEL',
  lpg: 'LPG',
  'benzin & lpg': 'LPG',
  'benzin/lpg': 'LPG',
  hibrit: 'HYBRID',
  hybrid: 'HYBRID',
  elektrik: 'ELECTRIC',
  elektrikli: 'ELECTRIC',
};

const TRANSMISSIONS: Record<string, Transmission> = {
  manuel: 'MANUAL',
  düz: 'MANUAL',
  otomatik: 'AUTOMATIC',
  'yarı otomatik': 'SEMI_AUTOMATIC',
  'yarı-otomatik': 'SEMI_AUTOMATIC',
};

export function normalizeText(s: string): string {
  return s.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
}

/** "1.250.000 TL", "1.250.000,00 TL", "₺1,250,000", "85.000 km" → tam sayı. Kuruş kısmı atılır. */
export function parseInteger(input: string | number): number | null {
  if (typeof input === 'number') return Number.isSafeInteger(input) ? input : null;
  const withoutCents = input.trim().replace(/,\d{1,2}(?=\D*$)/, '');
  const digits = withoutCents.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 12) return null;
  return Number(digits);
}

export function parseFuel(s: string): Fuel {
  return FUELS[normalizeText(s)] ?? 'OTHER';
}

export function parseTransmission(s: string): Transmission | null {
  return TRANSMISSIONS[normalizeText(s)] ?? null;
}

/** En uzun eşleşen takma ad kazanır; takma adın ötesindeki kelimeler `trim` olur. */
export function createAliasResolver(rows: AliasRow[]): MakeModelResolver {
  const entries = rows
    .map((row) => ({ key: normalizeText(row.rawText), row }))
    .sort((a, b) => b.key.length - a.key.length);
  return (text) => {
    const original = text.replace(/\s+/g, ' ').trim();
    const norm = normalizeText(original);
    for (const { key, row } of entries) {
      if (norm === key || norm.startsWith(`${key} `)) {
        const rest = original.slice(key.length).trim();
        return { make: row.make, model: row.model, trim: row.trim ?? (rest || null) };
      }
    }
    return null;
  };
}

function clean(s: string | null | undefined, max = 120): string | null {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function httpUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseDamage(d: RawListing['damage']): DamageInfo | null {
  if (!d) return null;
  const tramerAmount = d.tramerAmount === null || d.tramerAmount === undefined || d.tramerAmount === '' ? null : parseInteger(d.tramerAmount);
  const paintedParts = (d.paintedParts ?? []).map((p) => p.trim()).filter(Boolean);
  const changedParts = (d.changedParts ?? []).map((p) => p.trim()).filter(Boolean);
  if (tramerAmount === null && paintedParts.length === 0 && changedParts.length === 0) return null;
  return { tramerAmount, paintedParts, changedParts };
}

export function contentHash(listing: Omit<NormalizedListing, 'contentHash'>): string {
  const json = JSON.stringify(listing, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(json).digest('hex');
}

export type NormalizeResult = { ok: true; listing: NormalizedListing } | { ok: false; problems: ListingProblem[] };

export function normalizeListing(raw: RawListing, resolve: MakeModelResolver, now: Date = new Date()): NormalizeResult {
  const problems: ListingProblem[] = [];
  const externalId = (raw.externalId ?? '').trim();
  const fail = (field: string, problem: string) => problems.push({ externalId: externalId || undefined, field, problem });

  if (!externalId || externalId.length > 100) fail('externalId', 'boş veya 100 karakterden uzun');
  const title = clean(raw.title, 300);
  if (!title) fail('title', 'boş');
  const url = httpUrl(raw.url);
  if (!url) fail('url', 'geçerli bir http(s) adresi değil');
  const makeModel = resolve(raw.makeModelText ?? '');
  if (!makeModel) fail('makeModel', `bilinmeyen marka/model: ${String(raw.makeModelText ?? '').slice(0, 80)}`);
  const maxYear = now.getUTCFullYear() + 1;
  const year = parseInteger(raw.year);
  if (year === null || year < LIMITS.minYear || year > maxYear) fail('year', `${LIMITS.minYear}-${maxYear} aralığında olmalı`);
  const km = parseInteger(raw.km);
  if (km === null || km < LIMITS.minKm || km > LIMITS.maxKm) fail('km', `${LIMITS.minKm}-${LIMITS.maxKm} aralığında olmalı`);
  const price = parseInteger(raw.price);
  if (price === null || price < LIMITS.minPrice || price > LIMITS.maxPrice) {
    fail('price', `${LIMITS.minPrice}-${LIMITS.maxPrice} TL aralığında olmalı`);
  }
  const transmission = parseTransmission(raw.transmission ?? '');
  if (!transmission) fail('transmission', `bilinmeyen vites: ${String(raw.transmission ?? '').slice(0, 40)}`);

  if (problems.length > 0 || !title || !url || !makeModel || year === null || km === null || price === null || !transmission) {
    return { ok: false, problems };
  }

  const base: Omit<NormalizedListing, 'contentHash'> = {
    externalId,
    url,
    title,
    make: makeModel.make,
    model: makeModel.model,
    trim: makeModel.trim,
    year,
    km,
    price: BigInt(price),
    currency: 'TRY',
    fuel: parseFuel(raw.fuel ?? ''),
    transmission,
    city: clean(raw.city),
    imageUrl: httpUrl(raw.imageUrl),
    bodyType: clean(raw.bodyType),
    color: clean(raw.color),
    sellerType: clean(raw.sellerType),
    damageInfo: parseDamage(raw.damage),
  };
  return { ok: true, listing: { ...base, contentHash: contentHash(base) } };
}
