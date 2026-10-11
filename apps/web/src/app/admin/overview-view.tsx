'use client';
import Link from 'next/link';
import { BellOff } from 'lucide-react';
import { SourceStatusBadges } from '@/components/admin/catalog/source-status';
import { KpiGrid, KpiTile, formatCount, formatDurationMs } from '@/components/admin/kpi-tile';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminOverview, AdminSourceHealth } from '@/lib/admin-api';
import { QUEUE_LABEL } from '@/lib/admin-ops-api';
import { useAdminOverview, useRecentAlerts, type AlertItem } from '@/lib/admin-queries';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';

const REDIS_DOWN = "Redis'e ulaşılamıyor";

function Kpis({ o }: { o: AdminOverview }) {
  const n = o.notifications;
  const w = o.workers;
  return (
    <KpiGrid label="Özet göstergeler">
      <KpiTile
        label="Kullanıcılar"
        value={o.users.total}
        href="/admin/kullanicilar"
        hint={`bugün +${formatCount(o.users.newToday)}, ${formatCount(o.users.suspended)} askıda`}
      />
      <KpiTile label="Aktif arama profili" value={o.profiles.active} />
      <KpiTile
        label="Aktif ilan"
        value={o.listings.active}
        hint={`bugün +${formatCount(o.listings.newToday)} yeni, ${formatCount(o.listings.removedToday)} kalktı`}
      />
      <KpiTile label="Fırsat" value={o.opportunities.count} hint="skor ≥ 60, güven orta ve üstü" />
      <KpiTile
        label="Gönderilen bildirim (bugün)"
        value={n.sentToday}
        hint={`${formatCount(n.failedToday)} başarısız, ${formatCount(n.skippedLimitToday)} limitte kaldı`}
      />
      <KpiTile
        label="Bildirim gecikmesi p50"
        value={o.latency.p50}
        format={formatDurationMs}
        unavailableHint="Son 24 saatte ölçüm yok"
      />
      <KpiTile
        label="Bildirim gecikmesi p95"
        value={o.latency.p95}
        format={formatDurationMs}
        unavailableHint="Son 24 saatte ölçüm yok"
        tone={o.latency.p95 !== null && o.latency.p95 > 60_000 ? 'warning' : 'neutral'}
      />
      <KpiTile
        label="Worker'lar"
        value={w ? w.alive : null}
        unavailableHint={REDIS_DOWN}
        tone={w && w.dead > 0 ? 'danger' : 'neutral'}
        hint={w ? (w.dead > 0 ? `${formatCount(w.dead)} yanıt vermiyor` : 'Tümü yanıt veriyor') : undefined}
      />
    </KpiGrid>
  );
}

function SourceCard({ s }: { s: AdminSourceHealth }) {
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/admin/kaynaklar/${s.id}`} className="min-w-0 truncate font-medium hover:text-accent">
          {s.code}
        </Link>
        <div className="flex flex-wrap justify-end gap-1.5">
          <SourceStatusBadges source={s} />
        </div>
      </div>
      <p className="text-[13px] text-muted">
        {s.lastSuccessAt ? (
          <>
            Son başarılı tarama{' '}
            <time dateTime={s.lastSuccessAt} title={formatDateTime(s.lastSuccessAt)}>
              {formatRelative(s.lastSuccessAt)}
            </time>
          </>
        ) : (
          'Henüz başarılı tarama yok'
        )}
      </p>
    </li>
  );
}

function SourceHealth({ sources }: { sources: AdminSourceHealth[] }) {
  const down = sources.filter((s) => s.health === 'DOWN').length;
  return (
    <section aria-labelledby="kaynak-sagligi" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="kaynak-sagligi" className="font-display text-base font-semibold">
          Kaynak sağlığı
        </h2>
        <span className={cn('text-[13px]', down > 0 ? 'text-danger-text' : 'text-muted')}>
          {sources.length === 0 ? 'Kaynak tanımlı değil' : down > 0 ? `${down} kaynak çalışmıyor` : `${sources.length} kaynak`}
        </span>
      </div>
      {sources.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong/60 p-4 text-sm text-muted">
          Veri kaynağı eklendiğinde sağlık durumu burada görünür.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {sources.map((s) => (
            <SourceCard key={s.id} s={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueDepths({ queues }: { queues: Record<string, number> | null }) {
  const entries = queues ? Object.entries(queues) : [];
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <section aria-labelledby="kuyruklar" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="kuyruklar" className="font-display text-base font-semibold">
          Kuyruk derinlikleri
        </h2>
        <Link href="/admin/sistem" className="rounded-sm text-[13px] text-muted hover:text-text">
          Sistem izleme
        </Link>
      </div>
      {queues === null ? (
        <p className="text-sm text-warning-text">
          Kuyruk derinlikleri okunamadı: {REDIS_DOWN}. Bağlantı gelince sayılar kendiliğinden yenilenir.
        </p>
      ) : (
        <dl className="flex flex-col gap-2.5">
          {entries.map(([name, v]) => (
            <div key={name} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
              <dt className="truncate">{QUEUE_LABEL[name] ?? name}</dt>
              <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-muted/70"
                  style={{ width: `${v === 0 ? 0 : Math.max(2, (v / max) * 100)}%` }}
                />
              </div>
              <dd className="num text-right">{formatCount(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-muted">Bekleyen, çalışan ve geciktirilmiş işlerin toplamı.</p>
    </section>
  );
}

function AlertRow({ a }: { a: AlertItem }) {
  return (
    <li className="flex gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
      <span
        aria-hidden
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', a.level === 'ERROR' ? 'bg-danger' : 'bg-warning')}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm leading-snug break-words">{a.message}</p>
        <p className="text-xs text-muted">
          <span className="sr-only">{a.level === 'ERROR' ? 'Hata' : 'Uyarı'}, </span>
          <time dateTime={a.at} title={formatDateTime(a.at)}>
            {formatRelative(a.at)}
          </time>
          {a.origin === 'live' ? <span className="ml-2 font-medium text-text">yeni</span> : null}
        </p>
      </div>
    </li>
  );
}

function RecentAlerts() {
  const alerts = useRecentAlerts(8);
  return (
    <section aria-labelledby="son-alarmlar" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="son-alarmlar" className="font-display text-base font-semibold">
          Son alarmlar
        </h2>
        <Link href="/admin/loglar" className="rounded-sm text-[13px] text-muted hover:text-text">
          Tüm loglar
        </Link>
      </div>
      {alerts.isPending && alerts.items.length === 0 ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : alerts.items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <BellOff aria-hidden className="size-4" />
          {alerts.isError ? 'Loglar yüklenemedi. Yeni alarmlar yine de burada görünür.' : 'Kayıtlı alarm yok.'}
        </p>
      ) : (
        <ul aria-live="polite" className="flex flex-col">
          {alerts.items.map((a) => (
            <AlertRow key={a.id} a={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-[188px] w-full rounded-lg" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Skeleton className="h-[260px] rounded-lg" />
        <Skeleton className="h-[260px] rounded-lg" />
      </div>
    </div>
  );
}

export function AdminOverviewView() {
  const q = useAdminOverview();
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Genel bakış</h1>
      {q.isPending ? (
        <OverviewSkeleton />
      ) : q.isError ? (
        <EmptyState
          title="Genel bakış yüklenemedi"
          description="Bağlantınızı kontrol edip yeniden deneyin."
          action={
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Yeniden dene
            </Button>
          }
        />
      ) : (
        <>
          <Kpis o={q.data} />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-6">
              <SourceHealth sources={q.data.sources} />
              <QueueDepths queues={q.data.queues} />
            </div>
            <RecentAlerts />
          </div>
        </>
      )}
    </div>
  );
}
