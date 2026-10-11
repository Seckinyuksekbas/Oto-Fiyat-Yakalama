'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'motion/react';
import { Car, ExternalLink } from 'lucide-react';
import type { ListingCard } from '@oto/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { FUEL_LABEL, GEAR_LABEL, formatDiscount, formatKm, formatRelative, formatTl } from '@/lib/format';
import { ConfidenceMeter } from './confidence-meter';
import { FavoriteButton } from './favorite-button';
import { PriceBand } from './price-band';
import { ScoreRing } from './score-ring';

export function listingTitle(c: Pick<ListingCard, 'make' | 'model' | 'trim' | 'year'>): string {
  return `${[c.make, c.model, c.trim].filter(Boolean).join(' ')} · ${c.year}`;
}

export function ListingThumb({ card, className }: { card: ListingCard; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-surface-2', className)}>
      {card.imageUrl && !failed ? (
        <img
          src={card.imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <span className="grid size-full place-items-center text-border-strong">
          <Car aria-hidden className="size-6" />
        </span>
      )}
    </div>
  );
}

/** İndirim: piyasanın altı pozitif (yeşil), üstü nötr; yeşil yalnızca avantajı gösterir. */
export function DiscountText({ pct, className }: { pct: number | null | undefined; className?: string }) {
  const text = formatDiscount(pct ?? null);
  if (!text) return null;
  return <span className={cn('text-xs font-medium', (pct ?? 0) > 0 ? 'text-positive-text' : 'text-muted', className)}>{text}</span>;
}

export function ExternalListingLink({ url, title, className }: { url: string; title?: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={`İlana git${title ? `: ${title}` : ''} (yeni sekmede açılır)`}
      className={cn(
        'relative z-10 inline-grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text',
        className,
      )}
    >
      <ExternalLink aria-hidden className="size-[18px]" />
    </a>
  );
}

export interface ListingCardViewProps {
  card: ListingCard;
  /** Yeni gelen fırsat: tek seferlik amber parıltı (azaltılmış harekette yok). */
  highlight?: boolean;
  onToggleFavorite?: (next: boolean) => void;
}

export function ListingCardView({ card, highlight, onToggleFavorite }: ListingCardViewProps) {
  const reduce = useReducedMotion();
  const a = card.analysis;
  const removed = card.status === 'REMOVED';
  const meta = [formatKm(card.km), FUEL_LABEL[card.fuel] ?? card.fuel, GEAR_LABEL[card.transmission] ?? card.transmission];
  // Sunucu/istemci HTML'i aynı kalsın diye parıltı bağlandıktan sonra başlar.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const glow = Boolean(highlight) && mounted && !reduce;
  const title = listingTitle(card);

  return (
    <motion.article
      initial={false}
      animate={
        glow
          ? {
              boxShadow: [
                '0 0 0 1px color-mix(in oklab, var(--color-accent) 70%, transparent), 0 0 28px 2px color-mix(in oklab, var(--color-accent) 45%, transparent)',
                '0 0 0 1px transparent, 0 0 0 0 transparent',
              ],
            }
          : undefined
      }
      transition={{ duration: 1.2, ease: 'easeOut' }}
      className={cn(
        'group relative flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong focus-within:border-border-strong',
        removed && 'opacity-80',
      )}
    >
      <div className="flex gap-3">
        <ListingThumb card={card} className="h-[88px] w-[104px] shrink-0 sm:h-[96px] sm:w-[120px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-[15px] font-semibold leading-snug">
              <Link
                href={`/app/ilan/${card.id}`}
                className="outline-offset-4 after:absolute after:inset-0 after:content-[''] hover:text-accent focus-visible:text-accent"
              >
                {title}
              </Link>
            </h3>
            {a && <ScoreRing score={a.opportunityScore} size={44} />}
          </div>
          <p className="tnum mt-0.5 text-xs text-muted">{meta.join(' · ')}</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="num text-lg font-semibold leading-none">{formatTl(card.price)}</span>
            <DiscountText pct={a?.discountPct} />
            {removed && <Badge tone="danger">Yayından kalktı</Badge>}
          </div>
          {a && a.confidence !== 'INSUFFICIENT' && (
            <ConfidenceMeter confidence={a.confidence} comparableCount={a.comparableCount} compact className="mt-1.5" />
          )}
        </div>
      </div>

      <PriceBand
        band={a?.band ?? { q1: null, median: null, q3: null }}
        price={card.price}
        confidence={a?.confidence ?? 'INSUFFICIENT'}
        insufficientReason={a?.insufficientReason ?? 'NONE'}
      />

      <div className="flex items-center justify-between gap-2">
        <p className="tnum min-w-0 truncate text-xs text-muted">
          {[a ? `${a.comparableCount} emsal` : null, formatRelative(card.firstSeenAt), card.city].filter(Boolean).join(' · ')}
        </p>
        <div className="relative z-10 flex shrink-0 items-center">
          <FavoriteButton listingId={card.id} isFavorite={card.isFavorite} title={title} onChange={onToggleFavorite} />
          <ExternalListingLink url={card.url} title={title} />
        </div>
      </div>
    </motion.article>
  );
}
