import type { AnalysisResult, AnalysisSettings } from '@oto/analysis';
import type { MatchEvent } from '@oto/shared';

export type AnalysisEvent = 'NEW' | 'PRICE_DROP' | 'RELIST' | 'CHANGE' | 'REFRESH';

export interface ListingState {
  price: bigint;
  contentHash: string;
  relistedAt: Date | null;
}

export interface AnalyzedState {
  createdAt: Date;
  listingPrice: bigint | null;
  listingContentHash: string | null;
}

/** Olay, kuyruk verisinden değil ilanın güncel durumu ile son analiz arasındaki farktan türetilir. */
export function deriveEvent(listing: ListingState, latest: AnalyzedState | null): AnalysisEvent {
  if (!latest) return 'NEW';
  if (listing.relistedAt && listing.relistedAt > latest.createdAt) return 'RELIST';
  if (latest.listingContentHash === listing.contentHash) return 'REFRESH';
  if (latest.listingPrice !== null && listing.price < latest.listingPrice) return 'PRICE_DROP';
  return 'CHANGE';
}

export function isMatchEvent(e: AnalysisEvent): e is MatchEvent {
  return e === 'NEW' || e === 'PRICE_DROP' || e === 'RELIST';
}

/** Spec §4.2: tramer veya değişen parça → hasarlı. Boyalı parça tek başına hasar sayılmaz. */
export function isDamaged(info: unknown): boolean {
  if (!info || typeof info !== 'object') return false;
  const d = info as { tramerAmount?: unknown; changedParts?: unknown };
  return (typeof d.tramerAmount === 'number' && d.tramerAmount > 0) || (Array.isArray(d.changedParts) && d.changedParts.length > 0);
}

/** Gece yenilemesinde yeni satır yalnızca anlamlı değişiklikte yazılır. */
export function materiallyChanged(
  latest: { engineVersion: string; confidence: string; estimatedPrice: bigint | null },
  result: AnalysisResult,
  settings: AnalysisSettings,
): boolean {
  if (latest.engineVersion !== result.engineVersion || latest.confidence !== result.confidence) return true;
  const a = latest.estimatedPrice;
  const b = result.estimatedPrice;
  if (a === null || b === null) return a !== b;
  if (a === 0n) return b !== 0n;
  return Math.abs(Number(b - a)) / Number(a) > settings.refreshMinChangePct;
}
