import type { MatchEvent } from '@oto/shared';

export interface ProfileNotifyPrefs {
  notifyOnPriceDrop: boolean;
  /** Kesir: 0.05 = %5 */
  priceDropPct: number;
  notifyOnRelist: boolean;
}

/**
 * Profil başına eşleşme nedeni (spec §5.1):
 * - Profile bu ilan için hiç eşleşme yazılmamışsa olay ne olursa olsun NEW.
 * - RELIST olayı + notifyOnRelist → RELIST.
 * - notifyOnPriceDrop ve fiyat son eşleşme fiyatından en az priceDropPct düşük → PRICE_DROP.
 * - Aksi halde eşleşme yok.
 */
export function decideMatchReason(
  event: MatchEvent,
  profile: ProfileNotifyPrefs,
  lastMatchedPrice: bigint | null,
  price: bigint,
): MatchEvent | null {
  if (lastMatchedPrice === null) return 'NEW';
  if (event === 'RELIST' && profile.notifyOnRelist) return 'RELIST';
  if (profile.notifyOnPriceDrop) {
    const keepBp = BigInt(Math.round((1 - profile.priceDropPct) * 10_000));
    if (price * 10_000n <= lastMatchedPrice * keepBp) return 'PRICE_DROP';
  }
  return null;
}
