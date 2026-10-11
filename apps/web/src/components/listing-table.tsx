'use client';
import Link from 'next/link';
import type { ListingCard } from '@oto/shared';
import { Badge } from '@/components/ui/badge';
import { formatDiscount, formatKm, formatRelative, formatTl } from '@/lib/format';
import { ConfidenceMeter } from './confidence-meter';
import { FavoriteButton } from './favorite-button';
import { ExternalListingLink, ListingCardView, ListingThumb, listingTitle } from './listing-card';
import { PriceBand } from './price-band';
import { ScoreRing } from './score-ring';

/** Masaüstünde tablo; `md` altında kart listesi. */
export function ListingTable({ rows }: { rows: ListingCard[] }) {
  return (
    <>
      <ul className="grid gap-3 md:hidden">
        {rows.map((c) => (
          <li key={c.id}>
            <ListingCardView card={c} />
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
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
              const discount = formatDiscount(a?.discountPct ?? null);
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
                    {discount && <div className="text-xs font-medium text-positive-text">{discount}</div>}
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
                      <FavoriteButton listingId={c.id} isFavorite={c.isFavorite} />
                      <ExternalListingLink url={c.url} />
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
