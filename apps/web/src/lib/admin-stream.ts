'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { adminAlertEventSchema, adminJobEventSchema, type AdminAlertEvent, type AdminJobEvent } from '@oto/shared';
import { refreshSessionDetailed } from './api';
import type { AdminKpi, AdminOverview } from './admin-api';
import { adminKeys, alertId, prependLiveAlert, type AlertItem } from './admin-queries';
import { formatDateTime } from './format';
import { onLoggedOut } from './session';
import { backoffDelay, type StreamStatus } from './sse';

/**
 * Admin canlı akışı `GET /api/v1/admin/stream` (ADMIN+). Olaylar:
 * - `ready` → tam `AdminOverview` anlık görüntüsü (her bağlanmada; kaçırılan olaylar tekrar oynatılmaz)
 * - `alert` → `AdminAlertEvent` (`key`+`at` ile tekilleştirilir)
 * - `job`   → `AdminJobEvent` (CollectionJob durum değişimi)
 * - `kpi`   → `AdminKpi` (30 sn'de bir; Redis yoksa `queues`/`workers` null)
 * - `ping`  → 25 sn'de bir canlılık
 * Kullanıcı bildirim akışıyla (`lib/sse.ts`) aynı istemci kuralları: 60 sn watchdog, 14 dk 30 sn proaktif yenileme,
 * üstel geri çekilme (1→30 sn, ±%20), her yeniden bağlanmadan önce oturum yenileme; `expired` ise akış durur.
 */

export interface AdminStreamOptions {
  onReady(o: AdminOverview): void;
  onAlert(a: AdminAlertEvent): void;
  onJob?(j: AdminJobEvent): void;
  onKpi?(k: AdminKpi): void;
  onStatus?(s: StreamStatus): void;
  eventSourceFactory?: (url: string) => EventSource;
  refresh?: () => Promise<boolean | 'ok' | 'expired' | 'transient'>;
  random?: () => number;
}

export const ADMIN_STREAM_URL = '/api/v1/admin/stream';
const PROACTIVE_MS = 14 * 60_000 + 30_000;
const STALL_MS = 60_000;
const MAX_SEEN = 500;

const defaultFactory = (url: string): EventSource => new EventSource(url, { withCredentials: true });

function parseJson(e: Event): unknown {
  try {
    return JSON.parse(String((e as MessageEvent).data));
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createAdminStream(opts: AdminStreamOptions): { close(): void } {
  const factory = opts.eventSourceFactory ?? defaultFactory;
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  const seenAlerts = new Set<string>();
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

  const refreshThenConnect = async () => {
    if (opts.refresh) {
      let res: boolean | 'ok' | 'expired' | 'transient';
      try {
        res = await opts.refresh();
      } catch {
        res = 'transient';
      }
      if (res === false || res === 'expired') {
        stop();
        return;
      }
      if (res === 'transient') {
        if (!closed) reconnect(backoffDelay(attempt++, opts.random));
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
    const source = factory(ADMIN_STREAM_URL);
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
      const data = parseJson(e);
      if (!isObject(data)) return;
      attempt = 0;
      opts.onStatus?.('open');
      opts.onReady(data as unknown as AdminOverview);
    });
    source.addEventListener('alert', (e) => {
      alive();
      const r = adminAlertEventSchema.safeParse(parseJson(e));
      if (!r.success) return;
      const id = alertId(r.data);
      if (seenAlerts.has(id)) return;
      seenAlerts.add(id);
      if (seenAlerts.size > MAX_SEEN) seenAlerts.delete(seenAlerts.values().next().value as string);
      opts.onAlert(r.data);
    });
    source.addEventListener('job', (e) => {
      alive();
      const r = adminJobEventSchema.safeParse(parseJson(e));
      if (r.success) opts.onJob?.(r.data);
    });
    source.addEventListener('kpi', (e) => {
      alive();
      const data = parseJson(e);
      if (isObject(data)) opts.onKpi?.(data as unknown as AdminKpi);
    });
    source.addEventListener('error', () => {
      if (closed || es !== source) return;
      dropSource();
      clearTimeout(proactiveTimer);
      clearTimeout(watchdogTimer);
      opts.onStatus?.('connecting');
      reconnect(backoffDelay(attempt++, opts.random));
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

/** `kpi` olayını genel bakış önbelleğine işler; önbellek yoksa (henüz ready/GET gelmediyse) dokunmaz. */
export function mergeKpi(prev: AdminOverview | undefined, k: AdminKpi): AdminOverview | undefined {
  if (!prev) return prev;
  return { ...prev, notifications: k.notifications, queues: k.queues, workers: k.workers, sources: k.sources };
}

// ---------------------------------------------------------------- durum deposu ve iş olayı dinleyicileri

let status: StreamStatus = 'closed';
const statusListeners = new Set<() => void>();
function setStatus(s: StreamStatus) {
  if (s === status) return;
  status = s;
  for (const fn of [...statusListeners]) fn();
}

/** Kabuk başlığındaki "Canlı" göstergesi için akış durumu. */
export function useAdminStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
    () => 'closed',
  );
}

const jobListeners = new Set<(j: AdminJobEvent) => void>();

/** Task 11: yeniden analiz / dry-run sonucunu beklerken `job` olaylarını dinler. Abonelikten çıkış fonksiyonu döner. */
export function onAdminJob(fn: (j: AdminJobEvent) => void): () => void {
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}

function showAlertToast(a: AdminAlertEvent): void {
  const opts = { id: `alert-${alertId(a)}`, description: `Alarm · ${formatDateTime(a.at)}` };
  if (a.level === 'ERROR') toast.error(a.message, opts);
  else toast.warning(a.message, opts);
}

// ---------------------------------------------------------------- tek bağlantı

let active: { close(): void } | null = null;

export function closeAdminStream(): void {
  active?.close();
  active = null;
}

/** Admin kabuğunda bir kez çağrılır (yalnızca ADMIN/SUPER_ADMIN için): akışı açar ve admin önbelleğini günceller. */
export function useAdminStream(enabled = true): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    closeAdminStream();
    const stream = createAdminStream({
      refresh: refreshSessionDetailed,
      onStatus: setStatus,
      onReady: (o) => {
        qc.setQueryData(adminKeys.overview(), o);
        // Kopukluk sırasında kaçırılan alarmlar SystemLog'dan yeniden çekilir.
        void qc.invalidateQueries({ queryKey: ['admin', 'system-logs'] });
      },
      onAlert: (a) => {
        qc.setQueryData<AlertItem[]>(adminKeys.liveAlerts(), (prev) => prependLiveAlert(prev, a));
        showAlertToast(a);
      },
      onJob: (j) => {
        void qc.invalidateQueries({ queryKey: adminKeys.jobs.all });
        void qc.invalidateQueries({ queryKey: adminKeys.sources.all });
        for (const fn of [...jobListeners]) fn(j);
      },
      onKpi: (k) => {
        qc.setQueryData<AdminOverview>(adminKeys.overview(), (prev) => mergeKpi(prev, k));
      },
    });
    active = stream;
    const off = onLoggedOut(closeAdminStream);
    return () => {
      off();
      stream.close();
      if (active === stream) active = null;
    };
  }, [qc, enabled]);
}
