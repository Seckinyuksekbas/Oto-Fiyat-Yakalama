'use client';
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ScrollText } from 'lucide-react';
import { Pagination } from '@/components/admin/data-table';
import { JsonDiff } from '@/components/admin/json-diff';
import { DateFilter, TextFilter, dayEndIso, dayStartIso } from '@/components/admin/log-filters';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ADMIN_PAGE_SIZE } from '@/lib/admin-api';
import type { AuditLogItem, AuditLogsQuery } from '@/lib/admin-ops-api';
import { useAuditLogs } from '@/lib/admin-ops-queries';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';

/** Hedefe bağlantı verilebilen türler. */
function targetHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === 'User') return `/admin/kullanicilar/${encodeURIComponent(id)}`;
  if (type === 'Source') return `/admin/kaynaklar/${encodeURIComponent(id)}`;
  if (type === 'Listing') return `/admin/ilanlar/${encodeURIComponent(id)}`;
  return null;
}

function AuditEntry({ e }: { e: AuditLogItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const href = targetHref(e.targetType, e.targetId);
  return (
    <li className="border-t border-border first:border-t-0">
      <div className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[9.5rem_minmax(0,1fr)_auto] md:items-center">
        <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)} className="text-[13px] text-muted">
          {formatDateTime(e.createdAt)}
        </time>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium break-all">{e.action}</span>
          <span className="text-[13px] break-words text-muted">
            {e.actor ? e.actor.email : 'Sistem'}
            {e.targetType ? (
              <>
                {' '}
                → {e.targetType}
                {e.targetId ? (
                  href ? (
                    <>
                      {' '}
                      <Link href={href} className="text-text underline-offset-4 hover:underline">
                        {e.targetId}
                      </Link>
                    </>
                  ) : (
                    <span className="text-text"> {e.targetId}</span>
                  )
                ) : null}
              </>
            ) : null}
            {e.ip ? <span className="num">, IP {e.ip}</span> : null}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="justify-self-start md:justify-self-end"
        >
          {open ? 'Değişiklikleri gizle' : 'Değişiklikleri göster'}
          <ChevronDown aria-hidden className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </Button>
      </div>
      <div id={panelId} hidden={!open} className="px-4 pb-4">
        {open ? <JsonDiff before={e.before} after={e.after} /> : null}
      </div>
    </li>
  );
}

interface Draft {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}
const EMPTY: Draft = { actor: '', action: '', targetType: '', targetId: '', from: '', to: '' };

export function AuditView() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const d = useDebounced(draft, 300);
  const [page, setPage] = useState(1);
  const key = JSON.stringify(d);
  useEffect(() => setPage(1), [key]);

  const query: AuditLogsQuery = {
    page,
    pageSize: ADMIN_PAGE_SIZE,
    ...(d.actor.trim() ? { actor: d.actor.trim() } : {}),
    ...(d.action.trim() ? { action: d.action.trim() } : {}),
    ...(d.targetType.trim() ? { targetType: d.targetType.trim() } : {}),
    ...(d.targetId.trim() ? { targetId: d.targetId.trim() } : {}),
    ...(dayStartIso(d.from) ? { from: dayStartIso(d.from) } : {}),
    ...(dayEndIso(d.to) ? { to: dayEndIso(d.to) } : {}),
  };
  const logs = useAuditLogs(query);
  const set = (k: keyof Draft) => (v: string) => setDraft((s) => ({ ...s, [k]: v }));
  const filtered = Object.values(draft).some((v) => v.trim() !== '');

  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">Denetim kayıtları</h1>
      <form
        role="search"
        aria-label="Denetim süzgeçleri"
        className="flex flex-wrap items-end gap-x-4 gap-y-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <TextFilter label="Yapan (e-posta)" value={draft.actor} onChange={set('actor')} />
        <TextFilter label="Eylem" value={draft.action} onChange={set('action')} className="h-9 w-40" />
        <TextFilter label="Hedef türü" value={draft.targetType} onChange={set('targetType')} maxLength={50} className="h-9 w-36" />
        <TextFilter label="Hedef kimliği" value={draft.targetId} onChange={set('targetId')} className="h-9 w-40" />
        <DateFilter label="Başlangıç" value={draft.from} onChange={set('from')} />
        <DateFilter label="Bitiş" value={draft.to} onChange={set('to')} min={draft.from || undefined} />
        {filtered ? (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setDraft(EMPTY)}>
            Süzgeçleri temizle
          </Button>
        ) : null}
      </form>
      <p className="-mt-2 text-[13px] text-muted">Eylem ve e-posta kısmi eşleşir (ör. "plan" tüm paket eylemlerini getirir); hedef türü ve kimliği tam eşleşir.</p>

      {logs.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : logs.isError && !logs.data ? (
        <EmptyState
          title="Denetim kayıtları yüklenemedi"
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
            icon={<ScrollText className="size-5" />}
            title={filtered ? 'Bu süzgeçlere uyan kayıt yok' : 'Henüz denetim kaydı yok'}
            description={filtered ? 'Tarih aralığını genişletin ya da süzgeçleri temizleyin.' : 'Yönetici işlemleri burada listelenir.'}
          />
          {page > 1 ? <Pagination page={page} pageSize={ADMIN_PAGE_SIZE} total={logs.data.total} onPageChange={setPage} force /> : null}
        </>
      ) : (
        <div className={cn('flex flex-col gap-3', logs.isFetching && 'opacity-70')}>
          <ul aria-label="Denetim kayıtları" className="rounded-lg border border-border bg-surface text-sm">
            {logs.data.items.map((e) => (
              <AuditEntry key={e.id} e={e} />
            ))}
          </ul>
          <Pagination page={page} pageSize={ADMIN_PAGE_SIZE} total={logs.data.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
