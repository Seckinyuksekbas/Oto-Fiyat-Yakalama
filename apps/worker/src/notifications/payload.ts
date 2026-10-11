import type { Listing, ListingAnalysis } from '@oto/db';
import type { MatchEvent, MatchNotificationPayload } from '@oto/shared';

export function buildMatchPayload(i: {
  listing: Listing;
  analysis: ListingAnalysis;
  reason: MatchEvent;
  previousPrice: bigint | null;
  profile: { id: string; name: string };
  limitExceeded: boolean;
  /** İlanın ilk analizi mi? NEW olayı daha sonra (REFRESH/CHANGE ile) terfi ettiyse false: olay anı analiz zamanıdır. */
  firstAnalysis?: boolean;
}): MatchNotificationPayload {
  const { listing: l, analysis: a } = i;
  return {
    type: 'MATCH',
    reason: i.reason,
    profile: i.profile,
    listing: {
      id: l.id, title: l.title, make: l.make, model: l.model, trim: l.trim, year: l.year, km: l.km, fuel: l.fuel,
      transmission: l.transmission, city: l.city, price: (a.listingPrice ?? l.price).toString(), imageUrl: l.imageUrl, url: l.url,
      firstSeenAt: l.firstSeenAt.toISOString(),
    },
    analysis: {
      opportunityScore: a.opportunityScore, confidence: a.confidence, estimatedPrice: a.estimatedPrice?.toString() ?? null,
      priceDiff: a.priceDiff?.toString() ?? null, discountPct: a.discountPct === null ? null : Number(a.discountPct),
      comparableCount: a.comparableCount,
    },
    previousPrice: i.previousPrice?.toString() ?? null,
    limitExceeded: i.limitExceeded,
    eventAt: (i.reason === 'NEW' && i.firstAnalysis !== false ? l.firstSeenAt : a.createdAt).toISOString(),
  };
}
