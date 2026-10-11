'use client';
import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { RotateCcw, ServerCrash, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminQueueName } from '@oto/shared';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { adminSelectCls } from '@/components/admin/filter-select';
import { formatCount } from '@/components/admin/kpi-tile';
import { LatencyChart } from '@/components/admin/latency-chart';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ADMIN_PAGE_SIZE } from '@/lib/admin-api';
import {
  CHANNEL_LABEL,
  EVENT_LABEL,
  QUEUE_LABEL,
  opsErrorMessage,
  type AdminQueue,
  type AdminWorker,
  type LatencyRange,
  type StuckDispatch,
} from '@/lib/admin-ops-api';
import {
  useAdminQueues,
  useAdminWorkers,
  useNotificationLatency,
  useCleanQueue,
  useRetryFailedJobs,
  useResetDispatch,
  useStuckDispatches,
} from '@/lib/admin-ops-queries';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';

const REDIS_HINT = 'Redis bağlantısı gelince sayılar kendiliğinden yenilenir.';
const NOTIFY_QUEUES = new Set<AdminQueueName>(['notify', 'notify-telegram']);

function SectionHead({ id, title, children }: { id: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <h2 id={id} className="font-display text-base font-semibold">
        {title}
      </h2>
      {children}
    </div>
  );
}

/** Önceki veri ekrandayken yenileme düştü (ör. Redis kopuk): sayıların bayat olduğunu söyler. */
function StaleNote({ updatedAt }: { updatedAt: number }) {
  const iso = new Date(updatedAt).toISOString();
  return (
    <p role="status" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-warning-text">
      <ServerCrash aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Son veriler (
        <time dateTime={iso} title={formatDateTime(iso)}>
          {formatRelative(iso)}
        </time>
        ); şu an güncellenemiyor. {REDIS_HINT}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------- kuyruklar

/** Kuyruk durumları: renk + etiket birlikte (renk tek başına anlam taşımaz). */
const SEGMENTS = [
  { id: 'waiting', label: 'Bekleyen', dot: 'bg-muted', bar: 'bg-muted/70' },
  { id: 'active', label: 'Çalışan', dot: 'bg-positive', bar: 'bg-positive' },
  { id: 'delayed', label: 'Gecikmeli', dot: 'bg-warning', bar: 'bg-warning' },
  { id: 'failed', label: 'Başarısız', dot: 'bg-danger', bar: 'bg-danger' },
] as const;

function segmentValues(q: AdminQueue): Record<(typeof SEGMENTS)[number]['id'], number> {
  const c = q.counts;
  return { waiting: c.waiting + c.prioritized + c.paused, active: c.active, delayed: c.delayed, failed: c.failed };
}

type QueueDialog = { kind: 'retry' | 'clean'; queue: AdminQueue } | null;

function QueueCard({ q, onAction }: { q: AdminQueue; onAction(kind: 'retry' | 'clean'): void }) {
  const id = useId();
  const v = segmentValues(q);
  const total = SEGMENTS.reduce((s, x) => s + v[x.id], 0);
  const label = QUEUE_LABEL[q.name] ?? q.name;
  return (
    <article aria-labelledby={id} className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id={id} className="truncate font-display text-[15px] font-semibold">
          {label}
        </h3>
        {q.isPaused ? <StatusBadge status="PAUSED" /> : <span className="text-xs text-muted">{q.name}</span>}
      </div>

      <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-surface-2">
        {total > 0
          ? SEGMENTS.map((s) =>
              v[s.id] > 0 ? (
                <span key={s.id} className={cn('h-full', s.bar)} style={{ width: `${Math.max(3, (v[s.id] / total) * 100)}%` }} />
              ) : null,
            )
          : null}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {SEGMENTS.map((s) => (
          <div key={s.id} role="group" aria-label={s.label} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span aria-hidden className={cn('size-1.5 rounded-full', s.dot)} />
              {s.label}
            </span>
            <span
              className={cn(
                'num text-lg leading-tight',
                s.id === 'failed' && v.failed > 0 ? 'text-danger-text' : v[s.id] === 0 ? 'text-muted' : 'text-text',
              )}
            >
              {formatCount(v[s.id])}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        Tamamlanan (saklanan) <span className="num text-text">{formatCount(q.counts.completed)}</span>
      </p>

      <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
        <Button variant="secondary" size="sm" disabled={q.counts.failed === 0} onClick={() => onAction('retry')}>
          <RotateCcw aria-hidden />
          Başarısızları yeniden dene
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAction('clean')}>
          <Trash2 aria-hidden />
          Temizle
        </Button>
      </div>
    </article>
  );
}

const CLEAN_AGES = [
  { value: 3600, label: '1 saatten eski' },
  { value: 86_400, label: '24 saatten eski' },
  { value: 604_800, label: '7 günden eski' },
];

function QueueDialogs({ dialog, onClose }: { dialog: QueueDialog; onClose(): void }) {
  const retryJobs = useRetryFailedJobs();
  const cleanJobs = useCleanQueue();
  const [state, setState] = useState<'completed' | 'failed'>('completed');
  const [age, setAge] = useState(86_400);
  const stateId = useId();
  const ageId = useId();
  const q = dialog?.queue;
  const label = q ? (QUEUE_LABEL[q.name] ?? q.name) : '';
  const notify = q ? NOTIFY_QUEUES.has(q.name) : false;

  const retry = async () => {
    if (!q) return;
    const r = await retryJobs.mutateAsync(q.name);
    if (r.retried === 0 && r.skipped === 0) {
      toast('Yeniden denenecek başarısız iş yok');
      return;
    }
    toast.success('Başarısız işler yeniden denendi', {
      description:
        r.skipped > 0
          ? `${formatCount(r.retried)} iş yeniden denendi, ${formatCount(r.skipped)} iş atlandı.`
          : `${formatCount(r.retried)} iş yeniden denendi.`,
    });
  };

  const clean = async () => {
    if (!q) return;
    const r = await cleanJobs.mutateAsync({ name: q.name, body: { state, olderThanSec: age } });
    if (r.removed === 0) toast('Silinecek iş yok', { description: 'Seçilen yaştan eski iş bulunamadı.' });
    else toast.success('Kuyruk temizlendi', { description: `${formatCount(r.removed)} iş silindi.` });
  };

  return (
    <>
      <ConfirmDialog
        open={dialog?.kind === 'retry'}
        onOpenChange={(o) => (o ? undefined : onClose())}
        title={`${label} kuyruğundaki başarısız işler yeniden denensin mi?`}
        description={
          notify
            ? 'İşlere ait bildirimler yeniden gönderilir. Yalnızca son 7 günün, aktif kullanıcılara ait başarısız bildirimleri denenir; diğerleri atlanır.'
            : 'En fazla 1.000 başarısız iş, deneme hakları sıfırlanarak yeniden sıraya alınır.'
        }
        confirmLabel="Yeniden dene"
        onConfirm={retry}
        errorMessage={opsErrorMessage}
      />
      <ConfirmDialog
        open={dialog?.kind === 'clean'}
        onOpenChange={(o) => (o ? undefined : onClose())}
        title={`${label} kuyruğunu temizle`}
        description="Seçilen durumdaki eski işler Redis'ten kalıcı olarak silinir (istek başına en fazla 1.000). Veritabanı kayıtları etkilenmez."
        confirmLabel="Temizle"
        tone="danger"
        onConfirm={clean}
        errorMessage={opsErrorMessage}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={stateId} className="text-[13px] text-muted">
              Silinecek işler
            </label>
            <select
              id={stateId}
              className={adminSelectCls}
              value={state}
              onChange={(e) => setState(e.target.value === 'failed' ? 'failed' : 'completed')}
            >
              <option value="completed">Tamamlanan</option>
              <option value="failed">Başarısız</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ageId} className="text-[13px] text-muted">
              Şundan eski
            </label>
            <select id={ageId} className={adminSelectCls} value={age} onChange={(e) => setAge(Number(e.target.value))}>
              {CLEAN_AGES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

function Queues() {
  const queues = useAdminQueues();
  const [dialog, setDialog] = useState<QueueDialog>(null);
  return (
    <section aria-labelledby="kuyruklar" className="flex flex-col gap-3">
      <SectionHead id="kuyruklar" title="Kuyruklar">
        <span className="text-[13px] text-muted">15 saniyede bir yenilenir</span>
      </SectionHead>
      {queues.isPending ? (
        <div aria-busy="true" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[236px] rounded-lg" />
          ))}
        </div>
      ) : queues.isError && !queues.data ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-text">
          <ServerCrash aria-hidden className="mt-0.5 size-4 shrink-0" />
          Kuyruk sayıları okunamadı: kuyruk sunucusuna (Redis) ulaşılamıyor. {REDIS_HINT}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {queues.isError ? (
            <div className="sm:col-span-2 xl:col-span-3 2xl:col-span-5">
              <StaleNote updatedAt={queues.dataUpdatedAt} />
            </div>
          ) : null}
          {queues.data.map((q) => (
            <QueueCard key={q.name} q={q} onAction={(kind) => setDialog({ kind, queue: q })} />
          ))}
        </div>
      )}
      <QueueDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </section>
  );
}

// ---------------------------------------------------------------- worker'lar

const ROLE_LABEL: Record<string, string> = { worker: 'Worker', scheduler: 'Zamanlayıcı' };

function WorkerRow({ w }: { w: AdminWorker }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
      <StatusBadge status={w.alive ? 'ALIVE' : 'DEAD'} className="w-fit" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{w.host}</span>
        <span className="text-[13px] text-muted">
          {ROLE_LABEL[w.role] ?? w.role}, süreç <span className="num">{w.pid}</span>, başlangıç{' '}
          <time dateTime={w.startedAt} title={formatDateTime(w.startedAt)}>
            {formatRelative(w.startedAt)}
          </time>
        </span>
      </div>
      <span className={cn('col-start-2 text-[13px] sm:col-start-auto sm:text-right', w.alive ? 'text-muted' : 'text-danger-text')}>
        Son sinyal{' '}
        <time dateTime={w.lastSeenAt} title={formatDateTime(w.lastSeenAt)}>
          {formatRelative(w.lastSeenAt)}
        </time>
      </span>
    </li>
  );
}

function Workers() {
  const workers = useAdminWorkers();
  const dead = workers.data?.filter((w) => !w.alive).length ?? 0;
  return (
    <section aria-labelledby="workerlar" className="flex flex-col gap-3">
      <SectionHead id="workerlar" title="Worker'lar">
        {workers.data ? (
          <span className={cn('text-[13px]', dead > 0 ? 'text-danger-text' : 'text-muted')}>
            {dead > 0 ? `${dead} süreç yanıt vermiyor` : `${workers.data.length} süreç`}
          </span>
        ) : null}
      </SectionHead>
      {workers.isPending ? (
        <Skeleton aria-busy="true" className="h-[140px] rounded-lg" />
      ) : workers.isError && !workers.data ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-text">
          Worker durumu okunamadı: Redis'e ulaşılamıyor. {REDIS_HINT}
        </p>
      ) : workers.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong/60 p-4 text-sm text-muted">
          Son 24 saatte sinyal gönderen worker yok. Worker ve zamanlayıcı süreçleri başladığında burada görünür.
        </p>
      ) : (
        <>
        {workers.isError ? <StaleNote updatedAt={workers.dataUpdatedAt} /> : null}
        <ul aria-label="Worker'lar" className="rounded-lg border border-border bg-surface text-sm">
          {workers.data.map((w) => (
            <WorkerRow key={`${w.host}:${w.pid}`} w={w} />
          ))}
        </ul>
        </>
      )}
      <p className="text-xs text-muted">Sinyali 45 saniyeden eski süreçler yanıt vermiyor sayılır; son 24 saatte görülenler listelenir.</p>
    </section>
  );
}

// ---------------------------------------------------------------- gecikme

const RANGES: Array<{ value: LatencyRange; label: string }> = [
  { value: '24h', label: 'Son 24 saat' },
  { value: '7d', label: 'Son 7 gün' },
];

function Latency() {
  const [range, setRange] = useState<LatencyRange>('24h');
  const lat = useNotificationLatency(range);
  const rangeText = range === '24h' ? 'son 24 saat' : 'son 7 gün';
  return (
    <section aria-labelledby="gecikme" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <SectionHead id="gecikme" title="Bildirim gecikmesi">
        <div role="group" aria-label="Zaman aralığı" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
              className={cn(
                'h-7 rounded-[5px] px-3 text-[13px] transition-colors',
                range === r.value ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </SectionHead>
      <p className="-mt-2 text-[13px] text-muted">
        Olayın oluşmasından (ilanın ilk görülmesi ya da analiz) bildirimin gönderilmesine kadar geçen süre. Yalnızca gönderilmiş
        eşleşme bildirimleri.
      </p>
      {lat.isPending ? (
        <Skeleton aria-busy="true" className="h-[260px] rounded-md" />
      ) : lat.isError && !lat.data ? (
        <p className="text-sm text-muted">Gecikme ölçümleri yüklenemedi. Sayfayı yenileyip tekrar deneyin.</p>
      ) : (
        <div className={cn('grid gap-6 lg:grid-cols-2', lat.isFetching && 'opacity-70')}>
          <LatencyChart
            title="Nedene göre"
            caption={`Nedene göre gecikme (${rangeText})`}
            groups={(['NEW', 'PRICE_DROP', 'RELIST'] as const).map((k) => ({ key: k, label: EVENT_LABEL[k] ?? k, pct: lat.data.byReason[k] }))}
          />
          <LatencyChart
            title="Kanala göre"
            caption={`Kanala göre gecikme (${rangeText})`}
            groups={(['IN_APP', 'TELEGRAM', 'EMAIL'] as const).map((k) => ({ key: k, label: CHANNEL_LABEL[k], pct: lat.data.byChannel[k] }))}
          />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- takılı eşleştirme gönderimleri

function StuckDispatches() {
  const [page, setPage] = useState(1);
  const stuck = useStuckDispatches({ page, pageSize: ADMIN_PAGE_SIZE });
  const reset = useResetDispatch();
  const [target, setTarget] = useState<StuckDispatch | null>(null);
  // Sıfırlanan satır listeden kalkar; odak kaybolmasın diye bölüm başlığına döner.
  const headingRef = useRef<HTMLHeadingElement>(null);

  const columns: DataColumn<StuckDispatch>[] = [
    {
      id: 'listing',
      header: 'İlan',
      primary: true,
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <Link href={`/admin/ilanlar/${r.listingId}`} className="truncate font-medium hover:text-accent">
            {r.listing.title}
          </Link>
          <span className="truncate text-[13px] text-muted">
            {r.listing.make} {r.listing.model} <span className="num">{r.listing.year}</span>, analiz <span className="num">#{r.analysisId}</span>
          </span>
        </div>
      ),
    },
    { id: 'event', header: 'Olay', cell: (r) => (r.matchEvent ? (EVENT_LABEL[r.matchEvent] ?? r.matchEvent) : '—') },
    { id: 'attempts', header: 'Deneme', numeric: true, cell: (r) => formatCount(r.matchDispatchAttempts) },
    {
      id: 'createdAt',
      header: 'Analiz zamanı',
      cell: (r) => (
        <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)}>
          {formatRelative(r.createdAt)}
        </time>
      ),
    },
    {
      id: 'actions',
      header: 'İşlem',
      srOnlyHeader: true,
      cell: (r) => (
        <Button variant="secondary" size="sm" aria-label={`Analiz #${r.analysisId} için sayacı sıfırla`} onClick={() => setTarget(r)}>
          Sıfırla
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="takili" className="flex flex-col gap-3">
      <h2 id="takili" ref={headingRef} tabIndex={-1} className="font-display text-base font-semibold outline-none">
        Takılı eşleştirme gönderimleri
      </h2>
      <p className="-mt-1 max-w-[72ch] text-[13px] text-muted">
        10 denemede eşleştirme kuyruğuna alınamayan olaylar. Sayaç sıfırlanınca zamanlayıcı olayı bir sonraki turda yeniden
        gönderir.
      </p>
      <DataTable
        caption="Takılı eşleştirme gönderimleri"
        columns={columns}
        rowKey={(r) => r.analysisId}
        data={stuck.data}
        isPending={stuck.isPending}
        isFetching={stuck.isFetching && !stuck.isPending}
        isError={stuck.isError}
        onRetry={() => void stuck.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        empty={{ title: 'Takılı gönderim yok', description: 'Bir olay 10 denemede gönderilemezse burada listelenir ve alarm verilir.' }}
      />
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => (o ? undefined : setTarget(null))}
        title="Gönderim sayacı sıfırlansın mı?"
        description={
          target
            ? `"${target.listing.title}" ilanının ${target.matchEvent ? (EVENT_LABEL[target.matchEvent] ?? target.matchEvent).toLocaleLowerCase('tr-TR') : ''} olayı bir sonraki zamanlayıcı turunda yeniden gönderilir. Eşleşen kullanıcılar bildirim alabilir.`
            : undefined
        }
        confirmLabel="Sayacı sıfırla"
        returnFocusRef={headingRef}
        onConfirm={async () => {
          if (!target) return;
          const r = await reset.mutateAsync(target.analysisId);
          if (r.matchDispatchAttempts === 0) toast.success('Sayaç sıfırlandı', { description: 'Olay bir sonraki turda yeniden gönderilecek.' });
          else toast('Bu gönderim artık takılı değil', { description: 'Liste güncellendi.' });
        }}
      />
    </section>
  );
}

export function SystemMonitorView() {
  return (
    <div className="flex flex-col gap-10">
      <h1 className="sr-only">Sistem izleme</h1>
      <Queues />
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <Workers />
        <Latency />
      </div>
      <StuckDispatches />
    </div>
  );
}
