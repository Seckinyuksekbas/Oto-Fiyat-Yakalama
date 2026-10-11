'use client';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ERROR_KIND_LABEL, TRIGGER_LABEL, When } from '@/components/admin/catalog/cells';
import { DryRunPreview } from '@/components/admin/catalog/dry-run-preview';
import { KpiGrid, KpiTile, formatDurationMs } from '@/components/admin/kpi-tile';
import { StatusBadge } from '@/components/admin/status-badge';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { isTerminalJob, parseDryRun, type AdminJobDetail } from '@/lib/admin/catalog-api';
import { useAdminJob } from '@/lib/admin/catalog-queries';
import { formatDateTime } from '@/lib/format';
import { jobDuration } from '../jobs-view';

type JobError = AdminJobDetail['job']['errors'][number];

/** Hata URL'leri API'de maskelidir (`?…`); düz metin olarak gösterilir, bağlantıya çevrilmez. */
function ErrorList({ errors }: { errors: JobError[] }) {
  if (errors.length === 0) return <p className="text-sm text-muted">Bu işte kayıtlı tarama hatası yok.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {errors.map((e) => (
          <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={e.kind} label={ERROR_KIND_LABEL[e.kind] ?? e.kind} tone="danger" />
              {e.transient ? <span className="text-[12px] text-muted">geçici, yeniden denendi</span> : null}
              <span className="ml-auto text-[12px] text-muted">
                <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
              </span>
            </div>
            <p className="break-words text-sm">{e.message}</p>
            {e.url ? <p className="num break-all text-[12px] text-muted">{e.url}</p> : null}
          </li>
        ))}
      </ul>
      {errors.length >= 100 ? <p className="text-[13px] text-muted">İlk 100 hata gösteriliyor.</p> : null}
    </div>
  );
}

export function AdminJobDetailView({ id }: { id: number }) {
  const q = useAdminJob(id);

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-20 w-full max-w-xl" />
        <Skeleton className="h-[92px] w-full rounded-lg" />
      </div>
    );
  }
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'İş bulunamadı' : 'İş yüklenemedi'}
        description={notFound ? 'Eski işler zamanla temizlenir. İş listesine dönün.' : 'Bağlantınızı kontrol edip yeniden deneyin.'}
        action={
          notFound ? (
            <Button asChild variant="secondary">
              <Link href="/admin/isler">İşlere dön</Link>
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

  const j = q.data.job;
  const duration = jobDuration(j);
  const dry = j.dryRun ? parseDryRun(j.dryRunResult) : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link href="/admin/isler" className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted hover:text-text">
          <ArrowLeft aria-hidden className="size-4" />
          İşler
        </Link>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              İş <span className="num">#{j.id}</span>
            </h1>
            <StatusBadge status={j.status} />
            {j.dryRun ? <StatusBadge status="DRY_RUN" label="Dry-run" tone="accent" /> : null}
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
            <div className="flex gap-1.5">
              <dt>Kaynak</dt>
              <dd>
                <Link href={`/admin/kaynaklar/${j.sourceId}`} className="text-text hover:text-accent">
                  {j.sourceName}
                </Link>
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Tetikleyici</dt>
              <dd className="text-text">{TRIGGER_LABEL[j.trigger] ?? j.trigger}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Oluşturuldu</dt>
              <dd className="text-text">
                <When iso={j.createdAt} />
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Bitti</dt>
              <dd className="text-text">{j.finishedAt ? formatDateTime(j.finishedAt) : 'sürüyor'}</dd>
            </div>
          </dl>
        </div>
      </header>

      {j.errorSummary ? (
        <p className="max-w-[80ch] rounded-md border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_8%,transparent)] px-4 py-3 text-sm">
          {j.errorSummary}
        </p>
      ) : null}

      <KpiGrid label="İş özeti" className="md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Sayfa" value={j.pagesFetched} />
        <KpiTile label="Görülen kart" value={j.listingsSeen} />
        <KpiTile label="Yeni" value={j.dryRun ? null : j.listingsNew} unavailableHint="Dry-run yazmaz" />
        <KpiTile label="Güncellenen" value={j.dryRun ? null : j.listingsUpdated} unavailableHint="Dry-run yazmaz" />
        <KpiTile label="Hata" value={j.errorsCount} tone={j.errorsCount > 0 ? 'danger' : 'neutral'} />
        <KpiTile
          label="Süre"
          value={duration}
          format={formatDurationMs}
          unavailableHint="Henüz bitmedi"
          hint={j.avgResponseMs !== null ? `Ortalama yanıt ${formatDurationMs(j.avgResponseMs)}` : undefined}
        />
      </KpiGrid>

      {j.dryRun ? (
        <section aria-labelledby="dry-run-sonucu" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
          <h2 id="dry-run-sonucu" className="font-display text-base font-semibold">
            Dry-run sonucu
          </h2>
          {dry ? (
            <DryRunPreview result={dry} />
          ) : (
            <p className="text-sm text-muted">{isTerminalJob(j.status) ? 'Sonuç yok.' : 'Sonuç iş bitince burada görünür.'}</p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="is-hatalari" className="flex flex-col gap-3">
        <h2 id="is-hatalari" className="font-display text-base font-semibold">
          Hatalar
        </h2>
        <ErrorList errors={j.errors} />
      </section>
    </div>
  );
}
