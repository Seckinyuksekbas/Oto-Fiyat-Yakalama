'use client';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { BellOff, Loader2, RotateCcw, X } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { formatCount, formatDurationMs } from '@/components/admin/kpi-tile';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ADMIN_PAGE_SIZE } from '@/lib/admin-api';
import {
  CHANNEL_LABEL,
  EVENT_LABEL,
  KIND_LABEL,
  RETRY_MAX_IDS,
  RETRY_SKIP_LABEL,
  opsErrorMessage,
  type AdminNotificationRow,
  type AdminNotificationsQuery,
  type NotificationChannel,
  type NotificationKind,
  type NotificationRetryResult,
  type NotificationStatus,
} from '@/lib/admin-ops-api';
import { useAdminNotifications, useRetryNotifications } from '@/lib/admin-ops-queries';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';

const columns: DataColumn<AdminNotificationRow>[] = [
  {
    id: 'what',
    header: 'Bildirim',
    primary: true,
    cell: (n) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{n.title ?? KIND_LABEL[n.kind] ?? n.kind}</span>
        <span className="truncate text-[13px] text-muted">
          <span className="num">#{n.id}</span>, {KIND_LABEL[n.kind] ?? n.kind}
          {n.reason ? `, ${EVENT_LABEL[n.reason] ?? n.reason}` : ''}
        </span>
      </div>
    ),
  },
  {
    id: 'user',
    header: 'Kullanıcı',
    cell: (n) => (
      <div className="flex min-w-0 flex-col">
        <Link href={`/admin/kullanicilar/${encodeURIComponent(n.userId)}`} className="truncate hover:text-accent">
          {n.userEmail}
        </Link>
        {n.userStatus !== 'ACTIVE' ? <span className="text-xs text-warning-text">Hesap {n.userStatus === 'SUSPENDED' ? 'askıda' : 'silinmiş'}</span> : null}
      </div>
    ),
  },
  { id: 'channel', header: 'Kanal', cell: (n) => CHANNEL_LABEL[n.channel] ?? n.channel },
  { id: 'status', header: 'Durum', cell: (n) => <StatusBadge status={n.status} /> },
  { id: 'attempts', header: 'Deneme', numeric: true, cell: (n) => formatCount(n.attempts) },
  {
    id: 'error',
    header: 'Son hata',
    cell: (n) =>
      n.lastError ? (
        <span className="line-clamp-2 max-w-[28ch] text-[13px] break-words text-danger-text" title={n.lastError}>
          {n.lastError}
        </span>
      ) : n.latencyMs !== null ? (
        <span className="text-[13px] text-muted">
          Gecikme <span className="num">{formatDurationMs(n.latencyMs)}</span>
        </span>
      ) : (
        <span className="text-muted">—</span>
      ),
  },
  {
    id: 'createdAt',
    header: 'Oluşturulma',
    cell: (n) => (
      <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)} className="whitespace-nowrap">
        {formatRelative(n.createdAt)}
      </time>
    ),
  },
];

type Filters = Omit<AdminNotificationsQuery, 'page' | 'pageSize' | 'userId'>;

function RetryResult({ result, onDismiss }: { result: NotificationRetryResult; onDismiss(): void }) {
  const r = result.retried.length;
  const s = result.skipped.length;
  return (
    <div
      role="status"
      aria-label="Yeniden deneme sonucu"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex flex-col gap-0.5">
          <span className={r > 0 ? 'font-medium text-positive-text' : 'font-medium text-muted'}>
            {formatCount(r)} bildirim yeniden kuyruğa alındı
          </span>
          {s > 0 ? <span className="text-warning-text">{formatCount(s)} bildirim atlandı</span> : null}
        </p>
        <Button variant="ghost" size="sm" aria-label="Sonucu kapat" onClick={onDismiss}>
          <X aria-hidden />
        </Button>
      </div>
      {s > 0 ? (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border pt-3 text-[13px]">
          {result.skipped.map((x) => (
            <li key={x.id} className="flex gap-3">
              <span className="num w-16 shrink-0 text-muted">#{x.id}</span>
              <span>{RETRY_SKIP_LABEL[x.reason] ?? x.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function NotificationsOpsView() {
  const [filters, setFilters] = useState<Filters>({});
  const [userText, setUserText] = useState('');
  const userId = useDebounced(userText.trim(), 300);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<NotificationRetryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retry = useRetryNotifications();
  const userInputId = useId();

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [userId]);

  const query: AdminNotificationsQuery = { ...filters, ...(userId ? { userId } : {}), page, pageSize: ADMIN_PAGE_SIZE };
  const list = useAdminNotifications(query);

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K] | undefined) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
    setSelected(new Set());
  };
  const filtered = Boolean(userId || filters.status || filters.channel || filters.kind);
  const tooMany = selected.size > RETRY_MAX_IDS;

  const runRetry = async () => {
    if (selected.size === 0 || tooMany || retry.isPending) return;
    setError(null);
    try {
      const ids = [...selected].sort((a, b) => a - b);
      const res = await retry.mutateAsync(ids);
      setResult(res);
      setSelected(new Set());
    } catch (err) {
      setError(opsErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">Bildirimler</h1>
      <form
        role="search"
        aria-label="Bildirim süzgeçleri"
        className="flex flex-wrap items-end gap-x-4 gap-y-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <FilterSelect
          label="Durum"
          value={filters.status}
          onChange={(v) => setFilter('status', v as NotificationStatus | undefined)}
          options={[
            { value: 'FAILED', label: 'Başarısız' },
            { value: 'PENDING', label: 'Bekliyor' },
            { value: 'SENT', label: 'Gönderildi' },
            { value: 'SKIPPED_LIMIT', label: 'Limitte kaldı' },
          ]}
        />
        <FilterSelect
          label="Kanal"
          value={filters.channel}
          onChange={(v) => setFilter('channel', v as NotificationChannel | undefined)}
          options={(['IN_APP', 'TELEGRAM', 'EMAIL'] as const).map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
        />
        <FilterSelect
          label="Tür"
          value={filters.kind}
          onChange={(v) => setFilter('kind', v as NotificationKind | undefined)}
          options={(['MATCH', 'SYSTEM_ALERT', 'SECURITY'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={userInputId} className="text-[13px] text-muted">
            Kullanıcı kimliği
          </label>
          <Input
            id={userInputId}
            value={userText}
            maxLength={50}
            onChange={(e) => setUserText(e.target.value)}
            className="h-9 w-56"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => {
              setFilters({});
              setUserText('');
              setPage(1);
              setSelected(new Set());
            }}
          >
            Süzgeçleri temizle
          </Button>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2/60 px-4 py-2.5">
        <Button size="sm" disabled={selected.size === 0 || tooMany || retry.isPending} aria-busy={retry.isPending || undefined} onClick={() => void runRetry()}>
          {retry.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
          {`Seçilenleri yeniden dene (${selected.size})`}
        </Button>
        <p className="text-[13px] text-muted" aria-live="polite">
          {tooMany
            ? `Tek seferde en fazla ${RETRY_MAX_IDS} bildirim yeniden denenebilir; seçimi azaltın.`
            : selected.size > 0
              ? 'Kullanıcısı aktif olmayan, 7 günden eski ya da kuyrukta bekleyen bildirimler atlanır.'
              : 'Yalnızca başarısız bildirimler seçilebilir.'}
        </p>
        {selected.size > 0 ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
            Seçimi temizle
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      {result ? <RetryResult result={result} onDismiss={() => setResult(null)} /> : null}

      <DataTable
        caption="Bildirimler"
        columns={columns}
        rowKey={(n) => n.id}
        data={list.data}
        isPending={list.isPending}
        isFetching={list.isFetching && !list.isPending}
        isError={list.isError}
        onRetry={() => void list.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        selection={{
          selected,
          onChange: setSelected,
          rowLabel: (n) => `Bildirim #${n.id}`,
          isSelectable: (n) => n.status === 'FAILED',
        }}
        empty={{
          icon: <BellOff className="size-5" />,
          title: filtered ? 'Bu süzgeçlere uyan bildirim yok' : 'Henüz bildirim yok',
          description: filtered ? 'Süzgeçleri gevşetin ya da temizleyin.' : undefined,
        }}
      />
    </div>
  );
}
