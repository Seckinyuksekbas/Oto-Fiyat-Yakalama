'use client';
import { useEffect, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, FileWarning } from 'lucide-react';
import { Pagination } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { DateFilter, TextFilter, dayEndIso, dayStartIso } from '@/components/admin/log-filters';
import { StatusBadge } from '@/components/admin/status-badge';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ADMIN_PAGE_SIZE, adminApi, type SystemLogItem, type SystemLogsQuery } from '@/lib/admin-api';
import { adminKeys } from '@/lib/admin-queries';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';

/** Bağlam API'de zaten temizlenmiştir (gizli anahtarlar `[gizli]`, URL sorguları maskeli); yine de yalnızca metin basılır. */
function contextText(ctx: unknown): string {
  try {
    return JSON.stringify(ctx, null, 2) ?? String(ctx);
  } catch {
    return String(ctx);
  }
}

const hasContext = (ctx: unknown) =>
  ctx !== null && ctx !== undefined && !(typeof ctx === 'object' && !Array.isArray(ctx) && Object.keys(ctx as object).length === 0);

function LogEntry({ l }: { l: SystemLogItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const ctx = hasContext(l.context);
  return (
    <li className={cn('border-t border-border first:border-t-0', l.level === 'ERROR' && 'shadow-[inset_2px_0_0_var(--color-danger)]')}>
      <div className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[6.5rem_minmax(0,1fr)_auto] md:items-start">
        <StatusBadge status={l.level} className="w-fit" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="leading-snug break-words">{l.message}</p>
          <p className="text-[13px] text-muted">
            {l.component},{' '}
            <time dateTime={l.createdAt} title={formatDateTime(l.createdAt)}>
              {formatRelative(l.createdAt)}
            </time>
          </p>
        </div>
        {ctx ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            className="justify-self-start md:justify-self-end"
          >
            {open ? 'Bağlamı gizle' : 'Bağlamı göster'}
            <ChevronDown aria-hidden className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
          </Button>
        ) : (
          <span className="hidden text-[13px] text-muted md:block">Bağlam yok</span>
        )}
      </div>
      {ctx ? (
        <div id={panelId} hidden={!open} className="px-4 pb-4">
          {open ? (
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all">
              {contextText(l.context)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

interface Draft {
  level?: 'WARN' | 'ERROR';
  component: string;
  q: string;
  from: string;
  to: string;
}
const EMPTY: Draft = { component: '', q: '', from: '', to: '' };

export function SystemLogsView() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const d = useDebounced(draft, 300);
  const [page, setPage] = useState(1);
  const key = JSON.stringify(d);
  useEffect(() => setPage(1), [key]);

  const query: SystemLogsQuery = {
    page,
    pageSize: ADMIN_PAGE_SIZE,
    ...(d.level ? { level: d.level } : {}),
    ...(d.component.trim() ? { component: d.component.trim() } : {}),
    ...(d.q.trim() ? { q: d.q.trim() } : {}),
    ...(dayStartIso(d.from) ? { from: dayStartIso(d.from) } : {}),
    ...(dayEndIso(d.to) ? { to: dayEndIso(d.to) } : {}),
  };
  const logs = useQuery({
    queryKey: adminKeys.systemLogs(query),
    queryFn: () => adminApi.systemLogs(query),
    placeholderData: keepPreviousData,
  });
  const set = (k: 'component' | 'q' | 'from' | 'to') => (v: string) => setDraft((s) => ({ ...s, [k]: v }));
  const filtered = Boolean(draft.level || draft.component.trim() || draft.q.trim() || draft.from || draft.to);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">Sistem logları</h1>
      <form
        role="search"
        aria-label="Log süzgeçleri"
        className="flex flex-wrap items-end gap-x-4 gap-y-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <FilterSelect
          label="Seviye"
          value={draft.level}
          onChange={(v) => setDraft((s) => ({ ...s, level: v === 'WARN' || v === 'ERROR' ? v : undefined }))}
          options={[
            { value: 'ERROR', label: 'Hata' },
            { value: 'WARN', label: 'Uyarı' },
          ]}
        />
        <TextFilter label="Bileşen" value={draft.component} onChange={set('component')} className="h-9 w-40" />
        <TextFilter label="Mesajda ara" type="search" value={draft.q} onChange={set('q')} maxLength={200} className="h-9 w-56" />
        <DateFilter label="Başlangıç" value={draft.from} onChange={set('from')} />
        <DateFilter label="Bitiş" value={draft.to} onChange={set('to')} min={draft.from || undefined} />
        {filtered ? (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setDraft(EMPTY)}>
            Süzgeçleri temizle
          </Button>
        ) : null}
      </form>

      {logs.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : logs.isError && !logs.data ? (
        <EmptyState
          title="Loglar yüklenemedi"
          description="Süzgeç tarihlerini kontrol edin ya da yeniden deneyin."
          action={
            <Button variant="secondary" onClick={() => void logs.refetch()}>
              Yeniden dene
            </Button>
          }
        />
      ) : logs.data.items.length === 0 ? (
        <>
          <EmptyState
            icon={<FileWarning className="size-5" />}
            title={filtered ? 'Bu süzgeçlere uyan log yok' : 'Kayıtlı uyarı ya da hata yok'}
            description={filtered ? 'Tarih aralığını genişletin ya da süzgeçleri temizleyin.' : 'Alarmlar ve worker hataları burada listelenir.'}
          />
          {page > 1 ? <Pagination page={page} pageSize={ADMIN_PAGE_SIZE} total={logs.data.total} onPageChange={setPage} force /> : null}
        </>
      ) : (
        <div className={cn('flex flex-col gap-3', logs.isFetching && 'opacity-70')}>
          <ul aria-label="Sistem logları" className="rounded-lg border border-border bg-surface text-sm">
            {logs.data.items.map((l) => (
              <LogEntry key={l.id} l={l} />
            ))}
          </ul>
          <Pagination page={page} pageSize={ADMIN_PAGE_SIZE} total={logs.data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
