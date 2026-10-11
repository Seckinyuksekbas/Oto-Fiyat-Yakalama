'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FlaskConical, Loader2 } from 'lucide-react';
import { PERMISSION_LABEL, When, formatDay } from '@/components/admin/catalog/cells';
import { DryRunPreview } from '@/components/admin/catalog/dry-run-preview';
import { SourceToggle } from '@/components/admin/catalog/source-toggle';
import { StatusBadge } from '@/components/admin/status-badge';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { isTerminalJob, parseDryRun, testScrapeErrorMessage, type AdminSource } from '@/lib/admin/catalog-api';
import { catalogKeys, useAdminJob, useAdminProxies, useAdminSource, useTestScrape } from '@/lib/admin/catalog-queries';
import { onAdminJob } from '@/lib/admin-stream';
import { SourceForm } from './source-form';
import { SourceStats } from './source-stats';

// ---------------------------------------------------------------- test taraması

/**
 * Dry-run: en fazla 2 sayfa, ilk 20 normalize ilan, hiçbir yazma yok. 202 `{jobId}` sonrası iş detayı yoklanır;
 * admin akışındaki `job` olayı geldiğinde anında yeniden çekilir. Hatalar: 429 (dakikada 1), 409 (duraklatılmış,
 * devam eden iş, izin yok) sunucu metniyle.
 */
function DryRunPanel({ source }: { source: AdminSource }) {
  const qc = useQueryClient();
  const scrape = useTestScrape(source.id);
  const [jobId, setJobId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useAdminJob(jobId);
  const busy = useRef(false);
  const status = job.data?.job.status;
  const running = jobId !== null && (!status || !isTerminalJob(status)) && !job.isError;

  useEffect(() => {
    if (jobId === null) return;
    return onAdminJob((e) => {
      if (e.jobId === jobId) void qc.invalidateQueries({ queryKey: catalogKeys.jobs.detail(jobId) });
    });
  }, [jobId, qc]);

  const blocked = !source.permissionVerifiedAt
    ? 'İzin doğrulanmadan test taraması yapılamaz.'
    : source.health === 'PAUSED'
      ? 'Kaynak engel ya da elle duraklatma nedeniyle durdu. Önce nedeni inceleyip etkinleştirin.'
      : null;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const res = await scrape.mutateAsync();
      if (mounted.current) setJobId(res.jobId);
    } catch (err) {
      if (mounted.current) setError(testScrapeErrorMessage(err));
    } finally {
      busy.current = false;
    }
  };

  const result = job.data ? parseDryRun(job.data.job.dryRunResult) : null;

  return (
    <section aria-labelledby="test-taramasi" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-[64ch] flex-col gap-1">
          <h2 id="test-taramasi" className="font-display text-base font-semibold">
            Test taraması (dry-run)
          </h2>
          <p className="text-[13px] text-muted">
            En fazla 2 sayfa okur, ilk 20 ilanı normalize eder ve hiçbir şeyi kaydetmez. Etkin olmayan (duraklatılmamış) kaynakta da çalışır; engel
            nedeniyle duraklatılmış kaynakta çalışmaz. Kaynak başına dakikada bir kez başlatılabilir.
          </p>
        </div>
        <Button variant="secondary" disabled={blocked !== null || scrape.isPending || running} onClick={() => void start()}>
          {scrape.isPending || running ? <Loader2 aria-hidden className="animate-spin" /> : <FlaskConical aria-hidden />}
          Test taraması başlat
        </Button>
      </div>
      {blocked ? <p className="text-[13px] text-warning-text">{blocked}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}

      {jobId !== null ? (
        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
            <Link href={`/admin/isler/${jobId}`} className="hover:text-accent">
              İş <span className="num">#{jobId}</span>
            </Link>
            {status ? <StatusBadge status={status} /> : <StatusBadge status="QUEUED" />}
            {running ? <span className="text-[13px] text-muted">Sonuç bekleniyor…</span> : null}
          </div>
          {job.isError ? <p className="text-sm text-muted">İş durumu okunamadı. İşler sayfasından takip edin.</p> : null}
          {status === 'FAILED' && job.data?.job.errorSummary ? <p className="text-sm text-danger-text">{job.data.job.errorSummary}</p> : null}
          {status && isTerminalJob(status) ? result ? <DryRunPreview result={result} /> : <p className="text-sm text-muted">Sonuç yok.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- sayfa

function Header({ s }: { s: AdminSource }) {
  return (
    <header className="flex flex-col gap-4">
      <Link href="/admin/kaynaklar" className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" />
        Kaynaklar
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight">{s.name}</h1>
            <StatusBadge status={s.health} />
            {s.isActive ? null : <StatusBadge status="INACTIVE" label="Zamanlama kapalı" tone="neutral" />}
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
            <div className="flex gap-1.5">
              <dt>Kod</dt>
              <dd className="text-text">{s.code}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Son başarı</dt>
              <dd className="text-text">
                <When iso={s.lastSuccessAt} />
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Ardışık hata</dt>
              <dd className={s.consecutiveFailures > 0 ? 'num text-danger-text' : 'num text-text'}>{s.consecutiveFailures}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>İzin</dt>
              <dd className="text-text">
                {PERMISSION_LABEL[s.permissionType] ?? s.permissionType}
                {s.permissionVerifiedAt ? `, doğrulama ${formatDay(s.permissionVerifiedAt)}` : ', doğrulanmadı'}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-col items-start gap-2">
          <SourceToggle source={s} size="md" />
          <Link href={`/admin/isler?kaynak=${s.id}`} className="text-[13px] text-muted hover:text-text">
            Bu kaynağın işleri
          </Link>
        </div>
      </div>
    </header>
  );
}

export function AdminSourceDetailView({ id }: { id: number }) {
  const q = useAdminSource(id);
  const proxies = useAdminProxies();
  // Form yalnızca başarılı kayıttan sonra yeniden kurulur; worker her taramada `updatedAt`'i değiştirir ve akış
  // olayları kaynak sorgularını tazeler, bu yüzden `updatedAt` anahtarı yazılmakta olan değerleri silerdi.
  const [formVersion, setFormVersion] = useState(0);

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-24 w-full max-w-xl" />
        <Skeleton className="h-[200px] w-full rounded-lg" />
      </div>
    );
  }
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'Kaynak bulunamadı' : 'Kaynak yüklenemedi'}
        description={notFound ? 'Bağlantı hatalı olabilir. Kaynak listesine dönün.' : 'Bağlantınızı kontrol edip yeniden deneyin.'}
        action={
          notFound ? (
            <Button asChild variant="secondary">
              <Link href="/admin/kaynaklar">Kaynaklara dön</Link>
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
  const s = q.data.source;
  return (
    <div className="flex flex-col gap-8">
      <Header s={s} />
      <DryRunPanel source={s} />
      <SourceStats id={id} />
      {proxies.isPending ? (
        <Skeleton className="h-[420px] w-full rounded-lg" />
      ) : (
        <SourceForm
          key={formVersion}
          source={s}
          proxies={proxies.data?.items ?? []}
          proxiesError={proxies.isError}
          onSaved={() => setFormVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}
