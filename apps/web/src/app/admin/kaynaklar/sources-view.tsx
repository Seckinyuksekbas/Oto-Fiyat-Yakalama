'use client';
import Link from 'next/link';
import { Database, ShieldCheck, ShieldAlert } from 'lucide-react';
import { PERMISSION_LABEL, When, formatDay } from '@/components/admin/catalog/cells';
import { BLOCK_PAUSED_COPY, SourceStatusBadges, isBlockPaused } from '@/components/admin/catalog/source-status';
import { SourceToggle } from '@/components/admin/catalog/source-toggle';
import { formatCount } from '@/components/admin/kpi-tile';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminSourceRow } from '@/lib/admin/catalog-api';
import { useAdminSources } from '@/lib/admin/catalog-queries';
import { cn } from '@/lib/cn';

/** Sağlık rengi kartın sol kenarında ince bir şerit olarak da taşınır; anlamı her zaman rozet metni verir. */
const HEALTH_EDGE: Record<string, string> = {
  HEALTHY: 'before:bg-positive',
  DEGRADED: 'before:bg-warning',
  DOWN: 'before:bg-danger',
  PAUSED: 'before:bg-border-strong',
};

function SourceCard({ s }: { s: AdminSourceRow }) {
  const j = s.last24h.jobs;
  const l = s.last24h.listings;
  return (
    <article
      aria-labelledby={`kaynak-${s.id}`}
      className={cn(
        'relative flex flex-col gap-4 overflow-hidden rounded-lg border border-border bg-surface p-5 pl-6',
        'before:absolute before:inset-y-0 before:left-0 before:w-1',
        HEALTH_EDGE[s.health] ?? 'before:bg-border',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`kaynak-${s.id}`} className="font-display text-lg font-semibold leading-tight">
            <Link href={`/admin/kaynaklar/${s.id}`} className="hover:text-accent">
              {s.name}
            </Link>
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {s.code}, {s.adapterKey}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <SourceStatusBadges source={s} />
        </div>
      </header>
      {isBlockPaused(s) ? <p className="text-[13px] text-danger-text">{BLOCK_PAUSED_COPY}</p> : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-[13px] text-muted">Son başarı</dt>
          <dd>
            <When iso={s.lastSuccessAt} />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[13px] text-muted">Ardışık hata</dt>
          <dd className={cn('num', s.consecutiveFailures > 0 ? 'text-danger-text' : 'text-text')}>{s.consecutiveFailures}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[13px] text-muted">İşler, son 24 saat</dt>
          <dd>
            <span className="num">{formatCount(j.succeeded)}</span>
            <span className="text-muted"> / </span>
            <span className="num">{formatCount(j.total)}</span>
            <span className="text-muted"> başarılı</span>
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[13px] text-muted">İlanlar, son 24 saat</dt>
          <dd className="text-[13px]">
            <span className="num">{formatCount(l.new)}</span> yeni, <span className="num">{formatCount(l.updated)}</span> güncel,{' '}
            <span className="num">{formatCount(l.removed)}</span> kalktı
          </dd>
        </div>
      </dl>

      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-[13px]">
        {s.permissionVerifiedAt ? (
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-positive-text" />
        ) : (
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
        )}
        <div className="min-w-0">
          <p>
            <span className="font-medium">{PERMISSION_LABEL[s.permissionType] ?? s.permissionType}</span>
            <span className="text-muted">
              {s.permissionVerifiedAt ? `, doğrulama ${formatDay(s.permissionVerifiedAt)}` : ', doğrulama tarihi yok'}
            </span>
          </p>
          {s.permissionNote ? <p className="mt-0.5 line-clamp-2 text-muted">{s.permissionNote}</p> : null}
        </div>
      </div>

      <footer className="mt-auto flex flex-wrap items-start justify-between gap-3">
        <SourceToggle source={s} />
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/kaynaklar/${s.id}`}>Ayrıntılar ve test taraması</Link>
        </Button>
      </footer>
    </article>
  );
}

export function AdminSourcesView() {
  const q = useAdminSources();
  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">Kaynaklar</h1>
      <p className="max-w-[72ch] text-sm text-muted">
        Yalnızca izni doğrulanmış kaynaklar etkinleştirilebilir. Yöneticinin duraklattığı kaynakta yalnızca zamanlama kapanır; sağlık olduğu gibi
        kalır ve test taraması yapılabilir. Engel sinyali (403, captcha, robots) gelen kaynak kendiliğinden duraklar; nedeni inceleyip elle etkinleştirin.
      </p>
      {q.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
          <Skeleton className="h-[300px] rounded-lg" />
          <Skeleton className="h-[300px] rounded-lg" />
        </div>
      ) : q.isError ? (
        <EmptyState
          title="Kaynaklar yüklenemedi"
          description="Bağlantınızı kontrol edip yeniden deneyin."
          action={
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Yeniden dene
            </Button>
          }
        />
      ) : q.data.items.length === 0 ? (
        <EmptyState icon={<Database className="size-5" />} title="Tanımlı kaynak yok" description="Kaynaklar seed ya da API ile eklenir; izin notu ve doğrulaması zorunludur." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {q.data.items.map((s) => (
            <SourceCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
