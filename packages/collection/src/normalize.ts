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

/** Türkçe büyük/küçük harf katlama: tr-TR lower + NFC + birleşik nokta temizliği + ı→i. */
export function normalizeText(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .normalize('NFC')
    .replace(/̇/g, '')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

const FUEL_LABELS: Record<string, Fuel> = {
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

const TRANSMISSION_LABELS: Record<string, Transmission> = {
  manuel: 'MANUAL',
  düz: 'MANUAL',
  otomatik: 'AUTOMATIC',
  'yarı otomatik': 'SEMI_AUTOMATIC',
  'yarı-otomatik': 'SEMI_AUTOMATIC',
};

const FUELS = new Map<string, Fuel>(Object.entries(FUEL_LABELS).map(([k, v]) => [normalizeText(k), v]));
const TRANSMISSIONS = new Map<string, Transmission>(
  Object.entries(TRANSMISSION_LABELS).map(([k, v]) => [normalizeText(k), v]),
);

const THOUSANDS_FORM = /^(\d{1,3}(?:[.,]\d{3})+)(?:[.,]\d{1,2})?$/;
const PLAIN_FORM = /^(\d+)(?:[.,]\d{1,2})?$/;
const NUMERIC_TOKEN = /\d[\d.,]*\d|\d/g;

/**
 * "1.250.000 TL", "1.250.000,00 TL", "₺1,250,000", "85.000 km", "9600.50 TL" → tam sayı.
 * Kuruş/ondalık kısmı atılır. Belirsiz veya birden fazla sayı içeren girdi (ör. "1e6",
 * "2019 - 2020", "-85.000") `null` döner.
 */
export function parseInteger(input: unknown): number | null {
  if (typeof input === 'number') return Number.isSafeInteger(input) ? input : null;
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const firstDigit = s.search(/\d/);
  if (firstDigit === -1) return null;
  if (s.slice(0, firstDigit).includes('-')) return null;
  const tokens = s.match(NUMERIC_TOKEN) ?? [];
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  const intPart = THOUSANDS_FORM.exec(token)?.[1].replace(/[.,]/g, '') ?? PLAIN_FORM.exec(token)?.[1];
  if (intPart === undefined || intPart.length > 12) return null;
  return Number(intPart);
}

export function parseFuel(s: string): Fuel {
  return FUELS.get(normalizeText(s)) ?? 'OTHER';
}

export function parseTransmission(s: string): Transmission | null {
  return TRANSMISSIONS.get(normalizeText(s)) ?? null;
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
        const keyWords = key.split(' ').length;
        const rest = original.split(' ').slice(keyWords).join(' ');
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

/** Alanları sabit bir sırada diziye alır; nesne anahtar sırasından bağımsız, kararlı bir hash üretir. */
export function contentHash(listing: Omit<NormalizedListing, 'contentHash'>): string {
  const d = listing.damageInfo;
  const fields = [
    listing.externalId,
    listing.url,
    listing.title,
    listing.make,
    listing.model,
    listing.trim,
    listing.year,
    listing.km,
    listing.price.toString(),
    listing.currency,
    listing.fuel,
    listing.transmission,
    listing.city,
    listing.imageUrl,
    listing.bodyType,
    listing.color,
    listing.sellerType,
    d ? [d.tramerAmount, d.paintedParts, d.changedParts] : null,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
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
