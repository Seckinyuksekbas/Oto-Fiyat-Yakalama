'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { ListingDetail } from '@oto/shared';
import { ConfidenceBadge, ListingStatusBadge, When } from '@/components/admin/catalog/cells';
import { formatCount } from '@/components/admin/kpi-tile';
import { ConfidenceMeter } from '@/components/confidence-meter';
import { EmptyState } from '@/components/empty-state';
import { ExplanationPanel } from '@/components/explanation-panel';
import { PriceBand } from '@/components/price-band';
import { PriceHistoryChart } from '@/components/price-history-chart';
import { ScoreRing } from '@/components/score-ring';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { reanalyzeErrorMessage, type AdminAnalysisDetail, type AdminListingAnalysisEntry, type AdminListingDetail } from '@/lib/admin/catalog-api';
import { catalogKeys, useAdminAnalysis, useAdminListing, useReanalyze } from '@/lib/admin/catalog-queries';
import { cn } from '@/lib/cn';
import { FUEL_LABEL, GEAR_LABEL, formatDateTime, formatDiscount, formatKm, formatTl } from '@/lib/format';
import { MATCH_REASON_LABEL, isHttpUrl } from '@/lib/panel-queries';

/** Yeniden analiz sonucu bu süre içinde gelmezse beklemeyi bırakırız (iş kuyrukta kalmaya devam eder). */
const REANALYZE_WAIT_MS = 90_000;

// ---------------------------------------------------------------- yeniden analiz

type Outcome = null | 'queued' | 'done' | 'timeout';

const OUTCOME_TEXT: Record<Exclude<Outcome, null>, string> = {
  queued: 'Yeniden analiz kuyruğa alındı. Sonuç bekleniyor.',
  done: 'Yeni analiz hazır; değerler güncellendi.',
  timeout: 'Sonuç 90 saniyede gelmedi. İş kuyrukta sürüyor olabilir; analiz worker’ını kontrol edin.',
};

/**
 * 202 `{jobId}` sonrası `latestAnalysisId` değişene kadar ilan detayı yoklanır (analiz işleri admin akışında
 * `job` olayı üretmez; o olay yalnızca CollectionJob içindir). MANUAL neden her zaman yeni satır yazar.
 * Çift tıklama koruması: istek sürerken ve sonuç beklenirken düğme devre dışıdır (API de 60 sn aynı jobId'yi döner).
 */
function useReanalyzeFlow(id: number, detail: AdminListingDetail | undefined) {
  const qc = useQueryClient();
  const mutation = useReanalyze(id);
  const [baseline, setBaseline] = useState<{ value: number | null } | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const latest = detail?.listing.latestAnalysisId ?? null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!baseline || latest === null || latest === baseline.value) return;
    setBaseline(null);
    setOutcome('done');
    busy.current = false;
    toast.success('Yeniden analiz tamamlandı');
  }, [baseline, latest]);

  useEffect(() => {
    if (!baseline) return;
    const t = setTimeout(() => {
      setBaseline(null);
      setOutcome('timeout');
      busy.current = false;
    }, REANALYZE_WAIT_MS);
    return () => clearTimeout(t);
  }, [baseline]);

  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    const from = latest;
    try {
      await mutation.mutateAsync();
      if (!mounted.current) return; // sayfadan çıkıldı: toast/durum yok
      setOutcome('queued');
      setBaseline({ value: from });
      void qc.invalidateQueries({ queryKey: catalogKeys.listings.detail(id) });
    } catch (err) {
      busy.current = false;
      if (mounted.current) toast.error(reanalyzeErrorMessage(err));
    }
  };

  return { start, waiting: mutation.isPending || baseline !== null, outcome };
}

// ---------------------------------------------------------------- parçalar

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}

const scoreDelta = (cur: AdminListingAnalysisEntry, prev: AdminListingAnalysisEntry | undefined) => {
  if (!prev) return null;
  const d = Math.round(cur.opportunityScore) - Math.round(prev.opportunityScore);
  return d === 0 ? null : d;
};

/**
 * Analiz geçmişi: en yeni üstte. Her satır skor, bir önceki analize göre skor farkı, güven ve motor sürümü.
 * Dikey ray, satırlar arasındaki zamansal sırayı gösterir (gerçek bir sıra olduğu için).
 */
function AnalysisTimeline({ entries, latestId }: { entries: AdminListingAnalysisEntry[]; latestId: number | null }) {
  if (entries.length === 0) return <p className="text-sm text-muted">Bu ilan henüz analiz edilmedi.</p>;
  return (
    <ol aria-label="Analiz geçmişi" className="relative flex flex-col">
      {entries.map((a, i) => {
        const delta = scoreDelta(a, entries[i + 1]);
        const current = a.id === latestId;
        return (
          <li key={a.id} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
            <span aria-hidden className="relative flex justify-center">
              {i < entries.length - 1 ? <span className="absolute top-3 bottom-[-0.25rem] w-px bg-border" /> : null}
              <span className={cn('relative mt-1.5 size-2.5 rounded-full border-2', current ? 'border-accent bg-accent' : 'border-border-strong bg-surface')} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cn('num text-lg font-semibold leading-none', a.opportunityScore >= 60 ? 'text-accent' : 'text-text')}>
                  {Math.round(a.opportunityScore)}
                </span>
                {delta !== null ? (
                  <span className={cn('num text-[13px]', delta > 0 ? 'text-positive-text' : 'text-danger-text')}>
                    {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
                    <span className="sr-only"> puan, önceki analize göre</span>
                  </span>
                ) : null}
                <ConfidenceBadge confidence={a.confidence} />
                {current ? <span className="text-[12px] text-muted">geçerli analiz</span> : null}
              </div>
              <p className="text-[13px] text-muted">
                <time dateTime={a.createdAt}>{formatDateTime(a.createdAt)}</time>, motor <span className="num">{a.engineVersion}</span>
                {a.listingPrice ? (
                  <>
                    , fiyat <span className="num">{formatTl(a.listingPrice)}</span>
                  </>
                ) : null}
              </p>
              {a.matchEvent ? (
                <p className="text-[13px]">
                  Eşleşme olayı: {MATCH_REASON_LABEL[a.matchEvent as keyof typeof MATCH_REASON_LABEL] ?? a.matchEvent}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Admin yanıtında emsal satırları yok; motorun açıklamasındaki ham emsal listesinden Plan 06 paneline uygun satırlar üretilir. */
function comparablesFromExplanation(explanation: unknown): ListingDetail['comparables'] {
  const e = explanation && typeof explanation === 'object' ? (explanation as { comparables?: unknown }) : {};
  if (!Array.isArray(e.comparables)) return [];
  return e.comparables
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .slice(0, 30)
    .map((c) => ({
      id: Number(c.id) || 0,
      title: `İlan #${String(c.id)}`,
      city: null,
      url: '',
      year: Number(c.year) || 0,
      km: Number(c.km) || 0,
      price: String(Math.round(Number(c.price) || 0)),
      adjusted: String(Math.round(Number(c.adjusted) || 0)),
      damaged: c.damaged === true,
      outlier: c.outlier === true,
      clamped: c.clamped === true,
      status: 'ACTIVE' as const,
    }));
}

function toPanelDetail(d: AdminListingDetail, a: AdminAnalysisDetail['analysis'] | undefined): ListingDetail {
  return {
    ...d.listing,
    damageInfo: null,
    priceHistory: d.priceHistory,
    explanation: a?.explanation ?? null,
    comparables: a ? comparablesFromExplanation(a.explanation) : [],
    myMatches: [],
  };
}

function Explanation({ d }: { d: AdminListingDetail }) {
  const q = useAdminAnalysis(d.listing.latestAnalysisId);
  if (d.listing.latestAnalysisId !== null && q.isPending) return <Skeleton className="h-[280px] w-full rounded-lg" />;
  if (q.isError) return <p className="text-sm text-muted">Analiz açıklaması yüklenemedi.</p>;
  return <ExplanationPanel detail={toPanelDetail(d, q.data?.analysis)} />;
}

// ---------------------------------------------------------------- sayfa

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-20 w-full max-w-xl" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Skeleton className="h-[320px] rounded-lg" />
        <Skeleton className="h-[320px] rounded-lg" />
      </div>
    </div>
  );
}

export function AdminListingDetailView({ id }: { id: number }) {
  const [poll, setPoll] = useState(false);
  const q = useAdminListing(id, { poll });
  const flow = useReanalyzeFlow(id, q.data);
  const waitingForResult = flow.waiting;
  useEffect(() => setPoll(waitingForResult), [waitingForResult]);

  if (q.isPending) return <DetailSkeleton />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'İlan bulunamadı' : 'İlan yüklenemedi'}
        description={notFound ? 'Bağlantı hatalı olabilir. İlan listesinden arayın.' : 'Bağlantınızı kontrol edip yeniden deneyin.'}
        action={
          notFound ? (
            <Button asChild variant="secondary">
              <Link href="/admin/ilanlar">İlanlara dön</Link>
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Yeniden dene
            </Button>
          )
        }
      />
    );
  }

  const d = q.data;
  const l = d.listing;
  const a = l.analysis;
  const removed = l.status === 'REMOVED';
  const discount = a ? formatDiscount(a.discountPct) : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link href="/admin/ilanlar" className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted hover:text-text">
          <ArrowLeft aria-hidden className="size-4" />
          İlanlar
        </Link>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight break-words">{l.title}</h1>
            <ListingStatusBadge status={l.status} />
          </div>
          <p className="text-sm text-muted">
            <Link href={`/admin/kaynaklar/${l.sourceId}`} className="hover:text-text">
              {l.sourceCode}
            </Link>
            , kaynaktaki kimlik <span className="num text-text">{l.externalId}</span>
            {isHttpUrl(l.url) ? (
              <>
                {', '}
                <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 hover:text-text">
                  kaynakta aç
                  <ExternalLink aria-hidden className="size-3" />
                  <span className="sr-only">(yeni sekmede açılır)</span>
                </a>
              </>
            ) : null}
          </p>
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label="Fiyat ve fırsat skoru" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="num text-3xl font-semibold leading-none tracking-tight">{formatTl(l.price)}</p>
                <p className="mt-2 text-sm text-muted">
                  {a?.estimatedPrice ? (
                    <>
                      Tahmin <span className="num text-text">{formatTl(a.estimatedPrice)}</span>
                      {discount ? `, ${discount}` : ', piyasa düzeyinde'}
                    </>
                  ) : (
                    'Tahmin yok'
                  )}
                </p>
              </div>
              {a ? <ScoreRing score={a.opportunityScore} size={64} /> : null}
            </div>
            {a ? <ConfidenceMeter confidence={a.confidence} comparableCount={a.comparableCount} /> : null}
            <PriceBand
              size="lg"
              band={a?.band ?? { q1: null, median: null, q3: null }}
              price={l.price}
              confidence={a?.confidence ?? 'INSUFFICIENT'}
              insufficientReason={a?.insufficientReason ?? 'NONE'}
            />
          </section>

          <Explanation d={d} />

          <section aria-labelledby="fiyat-gecmisi" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="fiyat-gecmisi" className="mb-3 font-display text-base font-semibold">
              Fiyat geçmişi
            </h2>
            <PriceHistoryChart history={d.priceHistory} lastSeenAt={l.lastSeenAt} />
          </section>

          {d.issues.length > 0 ? (
            <section aria-labelledby="ilan-sorunlari" className="flex flex-col gap-3">
              <h2 id="ilan-sorunlari" className="font-display text-base font-semibold">
                Sorun kayıtları
              </h2>
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                {d.issues.map((i) => (
                  <li key={i.id} className="flex flex-col gap-1 px-4 py-3">
                    <p className="text-sm">
                      <code className="num text-[13px] text-muted">{i.field}</code> {i.problem}
                    </p>
                    {i.rawSnippet ? <code className="block break-all text-[12px] text-muted">{i.rawSnippet}</code> : null}
                    <When iso={i.createdAt} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="yeniden-analiz" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
            <h2 id="yeniden-analiz" className="font-display text-base font-semibold">
              Yeniden analiz
            </h2>
            <p className="text-[13px] text-muted">
              Güncel emsallerle yeni bir analiz yazar. Eşleşme olayları normal kurallarla türetilir; aynı ilan için 60 saniye içindeki tekrarlar aynı işe bağlanır.
            </p>
            <Button className="w-fit" variant="secondary" disabled={removed || waitingForResult} onClick={() => void flow.start()}>
              {waitingForResult ? <Loader2 aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
              {waitingForResult ? 'Analiz sırada…' : 'Yeniden analiz et'}
            </Button>
            {removed ? <p className="text-[13px] text-muted">Kaldırılmış ilan yeniden analiz edilemez.</p> : null}
            <p role="status" aria-live="polite" className="text-[13px] empty:hidden">
              {flow.outcome ? OUTCOME_TEXT[flow.outcome] : ''}
            </p>
          </section>

          <section aria-labelledby="analiz-gecmisi" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
            <h2 id="analiz-gecmisi" className="font-display text-base font-semibold">
              Analiz geçmişi
            </h2>
            <AnalysisTimeline entries={d.analyses} latestId={l.latestAnalysisId} />
          </section>

          <section aria-labelledby="ilan-bilgileri" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="ilan-bilgileri" className="font-display text-base font-semibold">
              İlan bilgileri
            </h2>
            <dl className="mt-2">
              <Fact label="Marka ve model">{[l.make, l.model, l.trim].filter(Boolean).join(' ')}</Fact>
              <Fact label="Yıl">
                <span className="num">{l.year}</span>
              </Fact>
              <Fact label="Kilometre">
                <span className="num">{formatKm(l.km)}</span>
              </Fact>
              <Fact label="Yakıt ve vites">
                {FUEL_LABEL[l.fuel] ?? l.fuel}, {GEAR_LABEL[l.transmission] ?? l.transmission}
              </Fact>
              {l.city ? <Fact label="Şehir">{l.city}</Fact> : null}
              {l.sellerType ? <Fact label="Satıcı">{l.sellerType}</Fact> : null}
              <Fact label="Eşleşme">
                <span className="num">{formatCount(l.matchCount)}</span>
              </Fact>
              <Fact label="İlk görülme">
                <When iso={l.firstSeenAt} />
              </Fact>
              <Fact label="Son görülme">
                <When iso={l.lastSeenAt} />
              </Fact>
              {l.removedAt ? (
                <Fact label="Yayından kalkma">
                  <When iso={l.removedAt} />
                </Fact>
              ) : null}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
