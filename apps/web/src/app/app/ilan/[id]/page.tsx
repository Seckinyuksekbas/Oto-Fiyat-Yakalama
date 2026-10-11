'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Car, ExternalLink, SearchX } from 'lucide-react';
import type { ListingDetail } from '@oto/shared';
import { EmptyState } from '@/components/empty-state';
import { ConfidenceMeter } from '@/components/confidence-meter';
import { ExplanationPanel } from '@/components/explanation-panel';
import { FavoriteButton } from '@/components/favorite-button';
import { DiscountText, listingTitle } from '@/components/listing-card';
import { PriceBand } from '@/components/price-band';
import { PriceHistoryChart } from '@/components/price-history-chart';
import { ScoreRing } from '@/components/score-ring';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import {
  FUEL_LABEL,
  GEAR_LABEL,
  formatDateTime,
  formatDiscount,
  formatKm,
  formatTl,
} from '@/lib/format';
import { apiErrorMessage } from '@/lib/messages';
import { LEGAL_NOTE, MATCH_REASON_LABEL, isHttpUrl, useListing } from '@/lib/panel-queries';

function NotFoundView() {
  return (
    <div className="mx-auto w-full max-w-xl pt-10">
      <EmptyState
        icon={<SearchX className="size-5" />}
        title="İlan bulunamadı"
        description="Bu ilan yok ya da erişiminiz yok. Bağlantı hatalı olabilir."
        action={
          <Button asChild>
            <Link href="/app/firsatlar">Fırsatlara dön</Link>
          </Button>
        }
      />
    </div>
  );
}

function Hero({ d }: { d: ListingDetail }) {
  const [failed, setFailed] = useState(false);
  return d.imageUrl && !failed ? (
    <img
      src={d.imageUrl}
      alt={listingTitle(d)}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="aspect-[4/3] w-full rounded-lg border border-border bg-surface-2 object-cover"
    />
  ) : (
    <div
      role="img"
      aria-label="Görsel yok"
      className="grid aspect-[4/3] w-full place-items-center rounded-lg border border-border bg-surface-2 text-border-strong"
    >
      <Car aria-hidden className="size-14" />
    </div>
  );
}

function Spec({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="tnum text-right text-sm">{value}</dd>
    </div>
  );
}

function DetailView({ d }: { d: ListingDetail }) {
  const a = d.analysis;
  const removed = d.status === 'REMOVED';
  const discount = formatDiscount(a?.discountPct ?? null);
  const weak = !a || a.confidence === 'INSUFFICIENT';
  const damage = d.damageInfo;
  const damaged =
    !!a?.flags.includes('DAMAGED') ||
    (!!damage && ((damage.tramerAmount ?? 0) > 0 || (damage.changedParts?.length ?? 0) > 0));
  const suspicious = !!a?.flags.includes('SUSPICIOUS_LOW');

  return (
    <article className="mx-auto flex w-full max-w-[1120px] flex-col gap-6">
      <Link href="/app/firsatlar" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" />
        Fırsatlar
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">{listingTitle(d)}</h1>
          <p className="mt-1 text-sm text-muted">{d.title}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {removed && (
              <Badge tone="danger">{`Yayından kalktı${d.removedAt ? ` · ${formatDateTime(d.removedAt)}` : ''}`}</Badge>
            )}
            {damaged && <Badge tone="warning">Hasar kaydı var</Badge>}
            {suspicious && <Badge tone="warning">Şüpheli derecede düşük fiyat</Badge>}
            {weak && <Badge>Zayıf tahmin</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <FavoriteButton listingId={d.id} isFavorite={d.isFavorite} title={listingTitle(d)} className="size-10" />
          {isHttpUrl(d.url) && (
            <Button asChild variant="secondary">
              <a href={d.url} target="_blank" rel="noopener noreferrer nofollow">
                İlana git
                <ExternalLink aria-hidden />
                <span className="sr-only">(yeni sekmede açılır)</span>
              </a>
            </Button>
          )}
        </div>
      </header>
      {removed && isHttpUrl(d.url) && (
        <p className="-mt-3 text-xs text-muted">İlan yayından kalktığı için kaynak bağlantısı artık çalışmayabilir.</p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Hero d={d} />
        <section aria-label="Fiyat ve fırsat skoru" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="num text-4xl font-semibold leading-none tracking-tight">{formatTl(d.price)}</p>
              <p className="mt-2 text-sm">
                {discount && weak ? (
                  <span className="text-muted">{`Tahmini değerin ${discount} (zayıf tahmin)`}</span>
                ) : discount ? (
                  <>
                    <span className="text-muted">Tahmini piyasa değerinin </span>
                    <DiscountText pct={a?.discountPct} className="text-sm" />
                  </>
                ) : (
                  <span className="text-muted">{weak ? 'Güvenilir bir indirim hesaplanamadı' : 'Piyasa değerine yakın'}</span>
                )}
              </p>
              {a?.estimatedPrice && (
                <p className="mt-0.5 text-xs text-muted">
                  {weak ? 'Zayıf tahmin: ' : 'Tahmini piyasa değeri: '}
                  <span className="num">{formatTl(a.estimatedPrice)}</span>
                </p>
              )}
            </div>
            {a && <ScoreRing score={a.opportunityScore} size={72} />}
          </div>
          {a && <ConfidenceMeter confidence={a.confidence} comparableCount={a.comparableCount} />}
          <PriceBand
            size="lg"
            band={a?.band ?? { q1: null, median: null, q3: null }}
            price={d.price}
            confidence={a?.confidence ?? 'INSUFFICIENT'}
            insufficientReason={a?.insufficientReason ?? 'NONE'}
          />
        </section>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="spec-title" className="rounded-lg border border-border bg-surface p-5">
          <h2 id="spec-title" className="font-display text-lg font-semibold">
            Özellikler
          </h2>
          <dl className="mt-2">
            <Spec label="Yıl" value={d.year} />
            <Spec label="Kilometre" value={formatKm(d.km)} />
            <Spec label="Yakıt" value={FUEL_LABEL[d.fuel] ?? d.fuel} />
            <Spec label="Vites" value={GEAR_LABEL[d.transmission] ?? d.transmission} />
            {d.bodyType && <Spec label="Kasa tipi" value={d.bodyType} />}
            {d.color && <Spec label="Renk" value={d.color} />}
            {d.city && <Spec label="Şehir" value={d.city} />}
            {d.sellerType && <Spec label="Satıcı" value={d.sellerType} />}
            <Spec label="İlk görülme" value={formatDateTime(d.firstSeenAt)} />
            <Spec label="Son görülme" value={formatDateTime(d.lastSeenAt)} />
          </dl>
        </section>

        <div className="flex flex-col gap-6">
          <section aria-labelledby="damage-title" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="damage-title" className="font-display text-lg font-semibold">
              Hasar bilgisi
            </h2>
            {!damage ? (
              <p className="mt-2 text-sm text-muted">İlanda hasar bilgisi paylaşılmamış.</p>
            ) : (
              <dl className="mt-2">
                <Spec label="Tramer" value={damage.tramerAmount ? formatTl(damage.tramerAmount) : 'Kayıt yok'} />
                <Spec
                  label="Boyalı parçalar"
                  value={damage.paintedParts?.length ? damage.paintedParts.join(', ') : 'Yok'}
                />
                <Spec
                  label="Değişen parçalar"
                  value={damage.changedParts?.length ? damage.changedParts.join(', ') : 'Yok'}
                />
              </dl>
            )}
          </section>

          <section aria-labelledby="hist-title" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="hist-title" className="mb-3 font-display text-lg font-semibold">
              Fiyat geçmişi
            </h2>
            <PriceHistoryChart history={d.priceHistory} lastSeenAt={d.lastSeenAt} />
          </section>
        </div>
      </div>

      <section aria-labelledby="matches-title" className="rounded-lg border border-border bg-surface p-5">
        <h2 id="matches-title" className="font-display text-lg font-semibold">
          Eşleşmelerim
        </h2>
        {d.myMatches.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Bu ilan henüz hiçbir arama profilinizle eşleşmedi.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {d.myMatches.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  <Badge tone="accent">{MATCH_REASON_LABEL[m.reason]}</Badge>
                  <span className="font-medium">{m.profile.name}</span>
                </span>
                <span className="num text-xs text-muted">{`${formatTl(m.matchedPrice)} · ${formatDateTime(m.createdAt)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ExplanationPanel detail={d} />

      <p className="max-w-[80ch] text-xs leading-relaxed text-muted">{LEGAL_NOTE}</p>
    </article>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="İlan yükleniyor" className="mx-auto flex w-full max-w-[1120px] flex-col gap-6">
      <Skeleton className="h-9 w-2/3" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="aspect-[4/3] w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}

export default function ListingPage() {
  const params = useParams<{ id: string }>();
  const raw = params?.id ?? '';
  const id = /^\d{1,10}$/.test(raw) ? Number(raw) : null;
  const q = useListing(id);

  if (id === null) return <NotFoundView />;
  if (q.isPending) return <Loading />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundView />;
    return (
      <div className="mx-auto w-full max-w-xl pt-10">
        <EmptyState
          title="İlan yüklenemedi"
          description={apiErrorMessage(q.error)}
          action={<Button onClick={() => void q.refetch()}>Yeniden dene</Button>}
        />
      </div>
    );
  }
  return <DetailView d={q.data} />;
}
