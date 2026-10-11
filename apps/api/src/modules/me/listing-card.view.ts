import type { Listing, ListingAnalysis } from '@oto/db';
import type { AnalysisSummary, ListingCard } from '@oto/shared';

type InsufficientReason = AnalysisSummary['insufficientReason'];
const REASONS: readonly InsufficientReason[] = ['NONE', 'NO_LEVEL', 'AFTER_OUTLIERS', 'INVALID_TARGET'];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Yuvarlanmış tam sayı dizgisi; sayı değilse null. */
export function roundedMoney(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : null;
}

export function toAnalysisSummary(a: ListingAnalysis): AnalysisSummary {
  const ex = asRecord(a.explanation);
  const stats = asRecord(ex?.stats);
  const reason = ex?.insufficientReason;
  return {
    opportunityScore: a.opportunityScore,
    confidence: a.confidence,
    estimatedPrice: a.estimatedPrice?.toString() ?? null,
    priceDiff: a.priceDiff?.toString() ?? null,
    discountPct: a.discountPct === null ? null : Number(a.discountPct),
    comparableCount: a.comparableCount,
    band: { q1: roundedMoney(stats?.q1), median: roundedMoney(stats?.median), q3: roundedMoney(stats?.q3) },
    flags: a.flags.map(String),
    insufficientReason: REASONS.includes(reason as InsufficientReason) ? (reason as InsufficientReason) : 'NONE',
  };
}

export function toListingCard(listing: Listing, analysis: ListingAnalysis | null, isFavorite: boolean): ListingCard {
  return {
    id: listing.id,
    title: listing.title,
    make: listing.make,
    model: listing.model,
    trim: listing.trim,
    year: listing.year,
    km: listing.km,
    fuel: listing.fuel,
    transmission: listing.transmission,
    city: listing.city,
    price: listing.price.toString(),
    imageUrl: listing.imageUrl,
    url: listing.url,
    status: listing.status,
    firstSeenAt: listing.firstSeenAt.toISOString(),
    analysis: analysis ? toAnalysisSummary(analysis) : null,
    isFavorite,
  };
}
