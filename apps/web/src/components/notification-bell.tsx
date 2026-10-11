'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useMarkRead, useRecentNotifications, useUnreadCount } from '@/lib/notification-queries';
import { describeNotification, type NotificationView } from '@/lib/notification-text';
import { useNotificationStream } from '@/lib/sse';
import { AppShell } from './app-shell';
import { isUnread } from './notification-item';

const STEP_MS = 70;
const MAX_ANIMATED_STEPS = 6;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Sayacı eski değerden yenisine birer birer artırır; reduced-motion ve büyük sıçramalarda anlık. */
export function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const from = shownRef.current;
    const set = (v: number) => {
      shownRef.current = v;
      setShown(v);
    };
    if (target <= from || from === 0 || target - from > MAX_ANIMATED_STEPS || prefersReducedMotion()) {
      set(target);
      return;
    }
    let cur = from;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      cur += 1;
      set(cur);
      if (cur < target) timer = setTimeout(tick, STEP_MS);
    };
    timer = setTimeout(tick, STEP_MS);
    return () => clearTimeout(timer);
  }, [target]);
  return shown;
}

/** Yalnızca artışları, ~1 sn gecikmeyle duyurur (art arda gelen olaylar tek duyuruda birleşir). */
export function useUnreadAnnouncement(value: number | undefined, delayMs = 1000): string {
  const [text, setText] = useState('');
  const prev = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (value === undefined) return;
    const before = prev.current;
    prev.current = value;
    if (before === undefined || value <= before) return;
    const timer = setTimeout(() => setText(`${value} okunmamış bildirim`), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return text;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unreadData = useUnreadCount().data;
  const unread = unreadData ?? 0;
  const announcement = useUnreadAnnouncement(unreadData);
  const shown = useCountUp(unread);
  const recent = useRecentNotifications(open);
  const markRead = useMarkRead();
  const items = recent.data?.items ?? [];

  return (
    <>
    <span role="status" className="sr-only">
      {announcement}
    </span>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={unread > 0 ? `Bildirimler, ${unread} okunmamış` : 'Bildirimler'}
        className="relative grid size-10 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2 data-[state=open]:text-text"
      >
        <Bell aria-hidden className="size-[18px]" />
        {shown > 0 ? (
          <span
            data-testid="bell-count"
            aria-hidden
            className="absolute right-0.5 top-0.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-accent px-1 font-mono text-[10.5px] font-semibold leading-none tabular-nums text-accent-fg ring-2 ring-bg"
          >
            {shown > 99 ? '99+' : shown}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(380px,calc(100vw-24px))] p-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="font-display text-[15px] font-semibold tracking-tight">Bildirimler</span>
          <DropdownMenuItem
            disabled={unread === 0 || markRead.isPending}
            onSelect={(e) => {
              e.preventDefault();
              markRead.mutate({ all: true });
            }}
            className="h-8 gap-1.5 px-2 text-[13px] text-muted"
          >
            <CheckCheck aria-hidden className="size-4" />
            Tümünü okundu yap
          </DropdownMenuItem>
        </div>
        <DropdownMenuSeparator className="m-0" />
        <div className="max-h-[min(420px,60dvh)] overflow-y-auto p-1">
          {recent.isPending ? (
            <p className="px-3 py-6 text-center text-sm text-muted">Yükleniyor…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted">
              Henüz bildirim yok. Arama profilinize uyan bir ilan çıktığında burada görünür.
            </p>
          ) : (
            items.map((n) => <BellRow key={n.id} n={n} onOpen={() => !n.readAt && markRead.mutate({ ids: [n.id] })} />)
          )}
        </div>
        <DropdownMenuSeparator className="m-0" />
        <DropdownMenuItem asChild className="justify-center rounded-t-none py-3 text-[13px] font-medium">
          <Link href="/app/bildirimler">Tümünü gör</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

function BellRow({ n, onOpen }: { n: NotificationView; onOpen: () => void }) {
  const d = describeNotification(n);
  const unread = isUnread(n);
  const body: ReactNode = (
    <>
      <span
        aria-hidden
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread ? 'bg-accent' : 'bg-transparent')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-sm', unread ? 'font-semibold' : 'font-medium text-muted')}>{d.title}</span>
        {d.detail ? <span className="truncate text-[13px] text-muted">{d.detail}</span> : null}
        <time dateTime={n.createdAt} className="text-xs text-muted">
          {formatRelative(n.createdAt)}
        </time>
      </span>
      {unread ? <span className="sr-only">Okunmamış</span> : null}
    </>
  );
  const cls = 'items-start gap-2.5 px-3 py-2.5';
  return d.href ? (
    <DropdownMenuItem asChild className={cls} onSelect={onOpen}>
      <Link href={d.href}>{body}</Link>
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem className={cls} onSelect={onOpen}>
      {body}
    </DropdownMenuItem>
  );
}

/** Panel kabuğu + canlı akış: akış oturum başına yalnızca burada bir kez açılır. */
export function PanelWithNotifications({ children }: { children: ReactNode }) {
  useNotificationStream();
  return <AppShell bellSlot={<NotificationBell />}>{children}</AppShell>;
}
