'use client';
import Link from 'next/link';
import { SearchX } from 'lucide-react';
import type { PreviewSearchProfileInput } from '@oto/shared';
import { DiscountText } from '@/components/listing-card';
import { ScoreRing } from '@/components/score-ring';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatKm, formatTl } from '@/lib/format';
import { apiErrorMessage } from '@/lib/messages';
import { usePreview, type PreviewItem } from '@/lib/profile-queries';

function MiniCard({ item }: { item: PreviewItem }) {
  const meta = [`${item.year}`, formatKm(item.km), item.city].filter(Boolean).join(' · ');
  return (
    <li className="relative flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors focus-within:border-border-strong hover:border-border-strong">
      <div className="min-w-0 flex-1">
        <Link
          href={`/app/ilan/${item.id}`}
          className="block truncate text-sm font-medium outline-offset-4 after:absolute after:inset-0 after:content-[''] hover:text-accent focus-visible:text-accent"
        >
          {[item.make, item.model].filter(Boolean).join(' ')}
        </Link>
        <p className="tnum mt-0.5 truncate text-xs text-muted">{meta}</p>
        <p className="mt-1 flex items-baseline gap-2">
          <span className="num text-sm font-semibold">{formatTl(item.price)}</span>
          <DiscountText pct={item.analysis.discountPct} />
        </p>
      </div>
      <ScoreRing score={item.analysis.opportunityScore} size={38} />
    </li>
  );
}

export interface ProfilePreviewProps {
  payload: PreviewSearchProfileInput;
  /** Önizlemeyi engelleyen alan hataları (görünür alan hatalarıyla aynı metinler). */
  problems?: string[];
  className?: string;
}

export function ProfilePreview({ payload, problems = [], className }: ProfilePreviewProps) {
  const q = usePreview(payload);
  const data = q.data;
  const stale = q.settling || q.isFetching;
  const est = data ? data.estimatedDailyMatches.toLocaleString('tr-TR', { maximumFractionDigits: 1 }) : null;

  return (
    <section aria-label="Canlı önizleme" className={cn('flex flex-col gap-4', className)}>
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-muted">Bu ölçütlerle</p>
        <div className={cn('mt-1 transition-opacity', stale && 'opacity-60')}
          aria-live="polite"
          aria-busy={stale}
        >
          {est !== null && q.valid ? (
            <>
              <span className="text-sm text-muted">Tahmini günde </span>
              <span className="num text-3xl font-semibold leading-none text-accent">~{est}</span>
              <span className="text-sm text-muted"> eşleşme</span>
            </>
          ) : q.valid ? (
            <Skeleton className="h-8 w-40" />
          ) : (
            <div className="text-sm text-warning-text">
              <p>Önizleme için işaretli alanları düzeltin.</p>
              {problems.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {problems.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Yeni profiller yalnızca bundan sonra analiz edilen ilanlar için bildirim gönderir. Aşağıdaki liste mevcut ilanlardan örnektir.
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium">Son 20 eşleşecek ilan</h2>
        {q.isError && !data ? (
          <p role="alert" className="text-sm text-danger-text">
            {apiErrorMessage(q.error)}
          </p>
        ) : !data && q.valid ? (
          <div aria-busy="true" aria-label="Önizleme yükleniyor" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[72px] rounded-md" />
            ))}
          </div>
        ) : data && data.items.length === 0 ? (
          <div className="flex items-start gap-3 rounded-md border border-dashed border-border-strong/60 p-4 text-sm text-muted">
            <SearchX aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>Şu an bu ölçütlere uyan ilan yok. Marka, yıl ya da fiyat sınırını genişletmeyi deneyin.</p>
          </div>
        ) : data ? (
          <ul className={cn('flex flex-col gap-2 transition-opacity', stale && 'opacity-60')}>
            {data.items.map((it) => (
              <MiniCard key={it.id} item={it} />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
