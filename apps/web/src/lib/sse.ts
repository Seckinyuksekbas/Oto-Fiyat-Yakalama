'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { UserEvent } from '@oto/shared';
import { refreshSession } from './api';
import { describeNotification, type NotificationView } from './notification-text';
import { onLoggedOut } from './session';

export type StreamStatus = 'connecting' | 'open' | 'closed';
export type NotificationEvent = UserEvent['notification'];

export interface NotificationStreamOptions {
  onReady(r: { unreadCount: number; lastId: number | null }): void;
  onNotification(n: NotificationEvent): void;
  onStatus?(s: StreamStatus): void;
  eventSourceFactory?: (url: string) => EventSource;
  /** Her yeniden bağlanmadan önce çağrılır (erişim token'ı yenileme). */
  refresh?: () => Promise<boolean>;
  now?: () => number;
}

const STREAM_URL = '/api/v1/me/notifications/stream';
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** Sunucu akışı 15 dk'da kapatır; kopuş yaşanmadan 30 sn önce yeniden bağlanılır. */
const PROACTIVE_MS = 14 * 60_000 + 30_000;
/** Sunucu 25 sn'de bir ping gönderir; 60 sn sessizlik takılı bağlantı sayılır. */
const STALL_MS = 60_000;

const defaultFactory = (url: string): EventSource => new EventSource(url, { withCredentials: true });

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(base * (1 + (random() * 0.4 - 0.2)));
}

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse(String((e as MessageEvent).data)) as T;
  } catch {
    return null;
  }
}

export function createNotificationStream(opts: NotificationStreamOptions): { close(): void } {
  const factory = opts.eventSourceFactory ?? defaultFactory;
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let lastId = 0;
  const seen = new Set<number>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let proactiveTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(proactiveTimer);
    clearTimeout(watchdogTimer);
    retryTimer = proactiveTimer = watchdogTimer = undefined;
  };
  const dropSource = () => {
    es?.close();
    es = null;
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimers();
    dropSource();
    opts.onStatus?.('closed');
  };

  /** false: oturum bitti, bağlanmayı bırak. Geçici hata (throw): üstel bekleme ile yeniden dene. */
  const refreshThenConnect = async () => {
    if (opts.refresh) {
      let ok: boolean;
      try {
        ok = await opts.refresh();
      } catch {
        if (!closed) reconnect(backoffDelay(attempt++));
        return;
      }
      if (!ok) {
        stop();
        return;
      }
    }
    if (!closed && !es) connect();
  };

  const reconnect = (delay: number) => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void refreshThenConnect();
    }, delay);
  };

  const connect = () => {
    opts.onStatus?.('connecting');
    const source = factory(STREAM_URL);
    es = source;
    const alive = () => {
      clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        if (closed || es !== source) return;
        dropSource();
        clearTimeout(proactiveTimer);
        void refreshThenConnect();
      }, STALL_MS);
    };
    alive();
    source.addEventListener('open', () => {
      alive();
      opts.onStatus?.('open');
    });
    source.addEventListener('ping', alive);
    source.addEventListener('ready', (e) => {
      alive();
      const r = parse<{ unreadCount: number; lastId: number | null }>(e);
      if (!r) return;
      attempt = 0;
      lastId = Math.max(lastId, r.lastId ?? 0);
      for (const id of seen) if (id <= lastId) seen.delete(id);
      opts.onStatus?.('open');
      opts.onReady(r);
    });
    source.addEventListener('notification', (e) => {
      alive();
      const n = parse<NotificationEvent>(e);
      if (!n || typeof n.id !== 'number' || n.channel !== 'IN_APP') return;
      if (n.id <= lastId || seen.has(n.id)) return; // zaten unreadCount içinde ya da tekrar
      seen.add(n.id);
      opts.onNotification(n);
    });
    source.addEventListener('error', () => {
      if (closed || es !== source) return;
      dropSource();
      clearTimeout(proactiveTimer);
      clearTimeout(watchdogTimer);
      opts.onStatus?.('connecting');
      reconnect(backoffDelay(attempt++));
    });
    clearTimeout(proactiveTimer);
    proactiveTimer = setTimeout(() => {
      if (closed) return;
      dropSource();
      clearTimeout(watchdogTimer);
      void refreshThenConnect();
    }, PROACTIVE_MS);
  };

  connect();

  return { close: stop };
}

// ---------------------------------------------------------------- toast sınırlayıcı

export interface ToastLimiterOptions {
  max?: number;
  windowMs?: number;
  now?: () => number;
  show: (n: NotificationEvent) => void;
  showOverflow: (count: number) => void;
}

/** 5 sn'de en fazla 3 toast; fazlası tek "+N yeni eşleşme" toast'unda toplanır. */
export function createToastLimiter(o: ToastLimiterOptions): (n: NotificationEvent) => void {
  const max = o.max ?? 3;
  const windowMs = o.windowMs ?? 5_000;
  const now = o.now ?? Date.now;
  let shown: number[] = [];
  let overflow = 0;
  return (n) => {
    const t = now();
    shown = shown.filter((s) => t - s < windowMs);
    if (shown.length < max) {
      overflow = 0;
      shown.push(t);
      o.show(n);
    } else {
      overflow += 1;
      o.showOverflow(overflow);
    }
  };
}

function showToast(n: NotificationEvent): void {
  const d = describeNotification(n as NotificationView);
  toast(d.title, { description: d.detail, id: `notif-${n.id}` });
}
function showOverflowToast(count: number): void {
  toast(`+${count} yeni eşleşme`, { id: 'notif-overflow' });
}

export const NOTIFICATION_KEYS = {
  unread: ['notifications', 'unread'] as const,
  list: ['notifications', 'list'] as const,
};

// ---------------------------------------------------------------- tek bağlantı

let active: { close(): void } | null = null;

/** Çıkışta oturum yayıncısı tarafından çağrılır. */
export function closeNotificationStream(): void {
  active?.close();
  active = null;
}

/** Panel düzeninde bir kez çağrılır: akışı açar, React Query önbelleğini günceller. */
export function useNotificationStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    closeNotificationStream();
    const push = createToastLimiter({ show: showToast, showOverflow: showOverflowToast });
    const stream = createNotificationStream({
      refresh: refreshSession,
      onReady: ({ unreadCount }) => {
        qc.setQueryData<number>(NOTIFICATION_KEYS.unread, unreadCount);
        void qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.list });
      },
      onNotification: (n) => {
        qc.setQueryData<number>(NOTIFICATION_KEYS.unread, (c) => (c ?? 0) + 1);
        void qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.list });
        // Güvenlik ve sistem bildirimleri eşleşme sınırlayıcısına takılmaz.
        if (n.kind === 'MATCH') push(n);
        else showToast(n);
      },
    });
    active = stream;
    const off = onLoggedOut(closeNotificationStream);
    return () => {
      off();
      stream.close();
      if (active === stream) active = null;
    };
  }, [qc]);
}
