'use client';
import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { ListingCard } from '@oto/shared';
import { Badge } from '@/components/ui/badge';
import { formatKm, formatRelative, formatTl } from '@/lib/format';
import { ConfidenceMeter } from './confidence-meter';
import { FavoriteButton } from './favorite-button';
import { DiscountText, ExternalListingLink, ListingCardView, ListingThumb, listingTitle } from './listing-card';
import { PriceBand } from './price-band';
import { ScoreRing } from './score-ring';

const MD = '(min-width: 768px)';

/** Sunucuda ve ilk istemci boyamasında `false` (kart listesi); tarayıcıda `matchMedia` ile güncellenir. */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Masaüstünde tablo; `md` altında kart listesi (yalnızca biri bağlanır). */
export function ListingTable({ rows, onToggleFavorite }: { rows: ListingCard[]; onToggleFavorite?: (id: number, next: boolean) => void }) {
  const wide = useMediaQuery(MD);

  if (!wide) {
    return (
      <ul className="grid gap-3">
        {rows.map((c) => (
          <li key={c.id}>
            <ListingCardView card={c} onToggleFavorite={onToggleFavorite && ((next) => onToggleFavorite(c.id, next))} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <div
        role="region"
        aria-label="İlan tablosu"
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-border"
      >
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <caption className="sr-only">İlan listesi</caption>
          <thead className="bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">İlan</th>
              <th scope="col" className="px-3 py-2 font-medium">Fiyat</th>
              <th scope="col" className="px-3 py-2 font-medium">Fiyat bandı</th>
              <th scope="col" className="px-3 py-2 font-medium">Skor</th>
              <th scope="col" className="px-3 py-2 font-medium">Güven</th>
              <th scope="col" className="px-3 py-2 font-medium">Eklendi</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">İşlemler</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const a = c.analysis;
              return (
                <tr key={c.id} className="border-t border-border bg-surface align-middle hover:bg-surface-2/60">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <ListingThumb card={c} className="h-12 w-16 shrink-0" />
                      <div className="min-w-0">
                        <Link href={`/app/ilan/${c.id}`} className="font-medium hover:text-accent">
                          {listingTitle(c)}
                        </Link>
                        <p className="num text-xs text-muted">{[formatKm(c.km), c.city].filter(Boolean).join(' · ')}</p>
                        {c.status === 'REMOVED' && <Badge tone="danger" className="mt-1">Yayından kalktı</Badge>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="num font-semibold">{formatTl(c.price)}</div>
                    <DiscountText pct={a?.discountPct} className="block" />
                  </td>
                  <td className="w-56 px-3 py-2">
                    <PriceBand
                      band={a?.band ?? { q1: null, median: null, q3: null }}
                      price={c.price}
                      confidence={a?.confidence ?? 'INSUFFICIENT'}
                      insufficientReason={a?.insufficientReason ?? 'NONE'}
                    />
                  </td>
                  <td className="px-3 py-2">{a ? <ScoreRing score={a.opportunityScore} size={40} /> : <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2">
                    {a ? <ConfidenceMeter confidence={a.confidence} comparableCount={a.comparableCount} compact /> : <span className="text-muted">—</span>}
                  </td>
                  <td className="num px-3 py-2 text-xs text-muted">{formatRelative(c.firstSeenAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end">
                      <FavoriteButton listingId={c.id} isFavorite={c.isFavorite} title={listingTitle(c)} onChange={onToggleFavorite && ((next) => onToggleFavorite(c.id, next))} />
                      <ExternalListingLink url={c.url} title={listingTitle(c)} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
