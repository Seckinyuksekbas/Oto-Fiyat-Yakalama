import { CATALOG, CITIES, COLORS, PARTS, TRANSMISSIONS, type CatalogModel } from './catalog';

export type Rng = () => number;

/** Küçük, deterministik PRNG (mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

export interface DemoListing {
  id: string;
  make: string;
  model: string;
  trim: string;
  year: number;
  km: number;
  price: number;
  fuel: string;
  transmission: string;
  city: string;
  color: string;
  bodyType: string;
  tramerAmount: number | null;
  paintedParts: string[];
  changedParts: string[];
  status: 'ACTIVE' | 'REMOVED';
  createdAt: number;
  isOpportunity: boolean;
}

/** Piyasa değeri: yılda %10 değer kaybı, km başına en fazla %30 düşüş. */
export function fairPrice(m: CatalogModel, year: number, km: number, currentYear: number): number {
  const age = Math.max(0, currentYear - year);
  return m.basePrice * 0.9 ** age * (1 - Math.min(km / 1_000_000, 0.3));
}

export const roundPrice = (n: number) => Math.round(n / 1000) * 1000;

/** Hiçbir ilan fiyatı bu değerin altına düşmez (TL). */
export const MIN_PRICE = 50_000;

/** İndirim oranını [0, 0.9] aralığına sıkıştırır. */
export const clampDiscount = (d: number) => Math.min(0.9, Math.max(0, d));

export function generateListing(rng: Rng, id: string, createdAt: number, currentYear: number, discount?: number): DemoListing {
  const m = pick(rng, CATALOG);
  const year = currentYear - Math.floor(rng() * 12);
  const age = currentYear - year;
  const km = age === 0 ? Math.round(rng() * 5000) : Math.round(age * 15_000 * (0.6 + rng() * 0.8));
  const fair = fairPrice(m, year, km, currentYear);
  const factor = discount !== undefined ? 1 - clampDiscount(discount) : 0.92 + rng() * 0.16;
  const damaged = rng() < 0.2;
  return {
    id,
    make: m.make,
    model: m.model,
    trim: pick(rng, m.trims),
    year,
    km,
    price: Math.max(MIN_PRICE, roundPrice(fair * factor)),
    fuel: pick(rng, m.fuels),
    transmission: pick(rng, TRANSMISSIONS),
    city: pick(rng, CITIES),
    color: pick(rng, COLORS),
    bodyType: m.bodyType,
    tramerAmount: damaged ? Math.round(rng() * 80) * 1000 + 5000 : null,
    paintedParts: damaged ? [pick(rng, PARTS)] : [],
    changedParts: damaged && rng() < 0.3 ? [pick(rng, PARTS)] : [],
    status: 'ACTIVE',
    createdAt,
    isOpportunity: discount !== undefined,
  };
}
