import { Prisma } from '@prisma/client';

export interface MatchFilter {
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  priceMin: bigint | null;
  priceMax: bigint | null;
  kmMax: number | null;
  fuels: string[];
  transmissions: string[];
  cities: string[];
  excludeDamaged: boolean;
  minDiscountPct: number;
  minConfidence: string;
}

export interface ListingFacts {
  make: string;
  model: string;
  year: number;
  km: number;
  price: bigint;
  fuel: string;
  transmission: string;
  city: string | null;
  damaged: boolean;
  confidence: string;
  discountPct: number | null;
}

export type RawDb = { $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T> };

type Side<K extends string> = Record<K, Prisma.Sql>;
type ProfileSide = Side<
  'make' | 'model' | 'yearMin' | 'yearMax' | 'priceMin' | 'priceMax' | 'kmMax' | 'fuels' | 'transmissions' | 'cities'
  | 'excludeDamaged' | 'minDiscountPct' | 'minConfidence'
>;
type ListingSide = Side<
  'make' | 'model' | 'year' | 'km' | 'price' | 'fuel' | 'transmission' | 'city' | 'damaged' | 'confidence' | 'discountPct'
>;

/** Spec §5.2 eşleştirme koşulu. TEK tanım: iki yön de bunu kullanır. */
function matchPredicate(p: ProfileSide, l: ListingSide): Prisma.Sql {
  return Prisma.sql`((
        (${p.make} IS NULL OR fold_tr(${p.make}) = fold_tr(${l.make}))
    AND (${p.model} IS NULL OR fold_tr(${p.model}) = fold_tr(${l.model}))
    AND (${p.yearMin} IS NULL OR ${l.year} >= ${p.yearMin})
    AND (${p.yearMax} IS NULL OR ${l.year} <= ${p.yearMax})
    AND (${p.priceMin} IS NULL OR ${l.price} >= ${p.priceMin})
    AND (${p.priceMax} IS NULL OR ${l.price} <= ${p.priceMax})
    AND (${p.kmMax} IS NULL OR ${l.km} <= ${p.kmMax})
    AND (coalesce(cardinality(${p.fuels}), 0) = 0 OR ${l.fuel} = ANY(${p.fuels}))
    AND (coalesce(cardinality(${p.transmissions}), 0) = 0 OR ${l.transmission} = ANY(${p.transmissions}))
    AND (coalesce(cardinality(${p.cities}), 0) = 0 OR fold_tr(${l.city}) IN (SELECT fold_tr(c) FROM unnest(${p.cities}) AS c))
    AND (${p.excludeDamaged} = false OR ${l.damaged} = false)
    AND (
          ${p.minDiscountPct} = 0
       OR ( (${l.confidence})::text <> 'INSUFFICIENT'
            AND ${l.discountPct} >= ${p.minDiscountPct}
            AND confidence_rank((${l.confidence})::text) >= confidence_rank((${p.minConfidence})::text) )
    )
  ) IS TRUE)`;
}

const col = (alias: string, name: string) => Prisma.raw(`${alias}."${name}"`);

const profileColumns = (a: string): ProfileSide => ({
  make: col(a, 'make'), model: col(a, 'model'), yearMin: col(a, 'yearMin'), yearMax: col(a, 'yearMax'),
  priceMin: col(a, 'priceMin'), priceMax: col(a, 'priceMax'), kmMax: col(a, 'kmMax'), fuels: col(a, 'fuels'),
  transmissions: col(a, 'transmissions'), cities: col(a, 'cities'), excludeDamaged: col(a, 'excludeDamaged'),
  minDiscountPct: col(a, 'minDiscountPct'), minConfidence: col(a, 'minConfidence'),
});

/** Parametreler açık tiplerle bağlanır; aksi halde `$1 IS NULL` "could not determine data type" hatası verir. */
const profileParams = (f: MatchFilter): ProfileSide => ({
  make: Prisma.sql`${f.make}::text`,
  model: Prisma.sql`${f.model}::text`,
  yearMin: Prisma.sql`${f.yearMin}::int`,
  yearMax: Prisma.sql`${f.yearMax}::int`,
  priceMin: Prisma.sql`${f.priceMin}::bigint`,
  priceMax: Prisma.sql`${f.priceMax}::bigint`,
  kmMax: Prisma.sql`${f.kmMax}::int`,
  fuels: Prisma.sql`${f.fuels}::"Fuel"[]`,
  transmissions: Prisma.sql`${f.transmissions}::"Transmission"[]`,
  cities: Prisma.sql`${f.cities}::text[]`,
  excludeDamaged: Prisma.sql`${f.excludeDamaged}::boolean`,
  minDiscountPct: Prisma.sql`${f.minDiscountPct}::numeric`,
  minConfidence: Prisma.sql`${f.minConfidence}::text`,
});

const listingColumns = (l: string, a: string): ListingSide => ({
  make: col(l, 'make'), model: col(l, 'model'), year: col(l, 'year'), km: col(l, 'km'), price: col(l, 'price'),
  fuel: col(l, 'fuel'), transmission: col(l, 'transmission'), city: col(l, 'city'),
  damaged: Prisma.raw(`('DAMAGED' = ANY(${a}."flags"))`), confidence: col(a, 'confidence'), discountPct: col(a, 'discountPct'),
});

const listingParams = (f: ListingFacts): ListingSide => ({
  make: Prisma.sql`${f.make}::text`,
  model: Prisma.sql`${f.model}::text`,
  year: Prisma.sql`${f.year}::int`,
  km: Prisma.sql`${f.km}::int`,
  price: Prisma.sql`${f.price}::bigint`,
  fuel: Prisma.sql`${f.fuel}::"Fuel"`,
  transmission: Prisma.sql`${f.transmission}::"Transmission"`,
  city: Prisma.sql`${f.city}::text`,
  damaged: Prisma.sql`${f.damaged}::boolean`,
  confidence: Prisma.sql`${f.confidence}::text`,
  discountPct: Prisma.sql`${f.discountPct}::numeric`,
});

export interface MatchingProfileRow {
  id: string;
  userId: string;
  name: string;
  channels: string[];
  notifyOnPriceDrop: boolean;
  priceDropPct: Prisma.Decimal;
  notifyOnRelist: boolean;
  /** Bu profile bu ilan için en son yazılan eşleşmenin fiyatı (yoksa null) */
  lastMatchedPrice: bigint | null;
}

export function findMatchingProfiles(db: RawDb, facts: ListingFacts, listingId: number): Promise<MatchingProfileRow[]> {
  return db.$queryRaw<MatchingProfileRow[]>(Prisma.sql`
    SELECT sp."id", sp."userId", sp."name", sp."channels"::text[] AS "channels", sp."notifyOnPriceDrop", sp."priceDropPct", sp."notifyOnRelist",
      (SELECT m."matchedPrice" FROM "ListingMatch" m
        WHERE m."searchProfileId" = sp."id" AND m."listingId" = ${listingId}::int
        ORDER BY m."id" DESC LIMIT 1) AS "lastMatchedPrice"
    FROM "SearchProfile" sp JOIN "User" u ON u."id" = sp."userId"
    WHERE sp."status" = 'ACTIVE' AND u."status" = 'ACTIVE'
      AND ${matchPredicate(profileColumns('sp'), listingParams(facts))}
    ORDER BY sp."id"`);
}

export interface PreviewListingRow {
  id: number;
  title: string;
  make: string;
  model: string;
  year: number;
  km: number;
  city: string | null;
  price: bigint;
  imageUrl: string | null;
  url: string;
  firstSeenAt: Date;
  opportunityScore: number;
  confidence: string;
  discountPct: Prisma.Decimal | null;
  estimatedPrice: bigint | null;
}

export function previewListings(db: RawDb, filter: MatchFilter, limit: number): Promise<PreviewListingRow[]> {
  return db.$queryRaw<PreviewListingRow[]>(Prisma.sql`
    SELECT l."id", l."title", l."make", l."model", l."year", l."km", l."city", l."price", l."imageUrl", l."url", l."firstSeenAt",
           a."opportunityScore", a."confidence"::text AS "confidence", a."discountPct", a."estimatedPrice"
    FROM "Listing" l JOIN "ListingAnalysis" a ON a."id" = l."latestAnalysisId"
    WHERE l."status" = 'ACTIVE' AND ${matchPredicate(profileParams(filter), listingColumns('l', 'a'))}
    ORDER BY l."firstSeenAt" DESC, l."id" DESC
    LIMIT ${limit}::int`);
}

export async function countPreviewSince(db: RawDb, filter: MatchFilter, since: Date): Promise<number> {
  const [row] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n
    FROM "Listing" l JOIN "ListingAnalysis" a ON a."id" = l."latestAnalysisId"
    WHERE l."status" = 'ACTIVE' AND l."firstSeenAt" >= ${since}
      AND ${matchPredicate(profileParams(filter), listingColumns('l', 'a'))}`);
  return Number(row?.n ?? 0);
}
