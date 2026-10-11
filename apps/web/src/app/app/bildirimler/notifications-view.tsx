'use client';
import { useEffect, useRef, useState } from 'react';
import { BellOff, CheckCheck } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { NotificationItem } from '@/components/notification-item';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import {
  useMarkRead,
  useNotificationsInfinite,
  useUnreadCount,
  type NotificationFilters,
} from '@/lib/notification-queries';
import type { NotificationView } from '@/lib/notification-text';

const selectCls =
  'h-9 rounded-md border border-border-strong bg-surface px-2.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-accent';

export function NotificationsView() {
  const [filters, setFilters] = useState<NotificationFilters>({});
  const q = useNotificationsInfinite(filters);
  const unread = useUnreadCount().data ?? 0;
  const markRead = useMarkRead();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const open = (n: NotificationView) => {
    if (n.channel === 'IN_APP' && !n.readAt) markRead.mutate({ ids: [n.id] });
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted" aria-live="polite">
          {unread > 0 ? `${unread} okunmamış bildirim` : 'Hepsini okudunuz'}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={unread === 0 || markRead.isPending}
          onClick={() => markRead.mutate({ all: true })}
        >
          <CheckCheck aria-hidden />
          Tümünü okundu yap
        </Button>
      </div>

      <form
        aria-label="Bildirim filtreleri"
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.unread ?? false}
            onChange={(e) => setFilters((f) => ({ ...f, unread: e.target.checked || undefined }))}
            className="size-4 accent-[var(--color-accent)]"
          />
          Yalnızca okunmamış
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Kanal
          <select
            className={cn(selectCls, 'text-text')}
            value={filters.channel ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, channel: (e.target.value || undefined) as NotificationFilters['channel'] }))
            }
          >
            <option value="">Tümü</option>
            <option value="IN_APP">Uygulama içi</option>
            <option value="TELEGRAM">Telegram</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Durum
          <select
            className={cn(selectCls, 'text-text')}
            value={filters.status ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: (e.target.value || undefined) as NotificationFilters['status'] }))
            }
          >
            <option value="">Tümü</option>
            <option value="SENT">Gönderildi</option>
            <option value="PENDING">Bekliyor</option>
            <option value="FAILED">Başarısız</option>
            <option value="SKIPPED_LIMIT">Limit</option>
          </select>
        </label>
      </form>

      {q.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[92px] w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState
          title="Bildirimler yüklenemedi"
          description="Bağlantınızı kontrol edip yeniden deneyin."
          action={<Button variant="secondary" onClick={() => void q.refetch()}>Yeniden dene</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BellOff className="size-5" />}
          title={filters.unread || filters.channel || filters.status ? 'Bu filtreyle bildirim yok' : 'Henüz bildirim yok'}
          description="Arama profilinize uyan bir ilan çıktığında burada görünür."
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((n) => (
            <li key={n.id}>
              <NotificationItem n={n} onOpen={open} />
            </li>
          ))}
        </ul>
      )}

      {hasNextPage ? (
        <div ref={sentinel} className="flex justify-center py-2">
          <Button variant="ghost" size="sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {isFetchingNextPage ? 'Yükleniyor…' : 'Daha fazla göster'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
