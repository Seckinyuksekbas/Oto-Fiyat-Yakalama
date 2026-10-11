import type { AdminPlanCreate, AdminPlanUpdate, AdminQueueClean, AdminQueueName, SettingKey } from '@oto/shared';
import { ApiError } from './api';
import { adminErrorMessage, adminGet, adminSend, type AdminPlan, type PageQuery, type Paged } from './admin-api';

/**
 * Task 12 uçları: kuyruklar, worker'lar, bildirim operasyonları, takılı eşleştirme gönderimleri, paket yazma,
 * sistem ayarları ve denetim kayıtları. Tipler API servislerinin gerçek dönüşlerinden türetildi
 * (`apps/api/src/modules/admin/*.service.ts`).
 */

// ---------------------------------------------------------------- kuyruklar ve worker'lar

export type QueueState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed' | 'prioritized' | 'paused';

export interface AdminQueue {
  name: AdminQueueName;
  isPaused: boolean;
  counts: Record<QueueState, number>;
}

export interface AdminWorker {
  host: string;
  pid: number;
  role: string;
  startedAt: string;
  lastSeenAt: string;
  alive: boolean;
}

// ---------------------------------------------------------------- bildirimler

export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED_LIMIT';
export type NotificationChannel = 'IN_APP' | 'TELEGRAM' | 'EMAIL';
export type NotificationKind = 'MATCH' | 'SYSTEM_ALERT' | 'SECURITY';

export interface AdminNotificationRow {
  id: number;
  userId: string;
  userEmail: string;
  userStatus: string;
  kind: NotificationKind;
  channel: NotificationChannel;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  title: string | null;
  reason: string | null;
  createdAt: string;
  queuedAt: string | null;
  sentAt: string | null;
  latencyMs: number | null;
}

export interface AdminNotificationsQuery extends PageQuery {
  status?: NotificationStatus;
  channel?: NotificationChannel;
  kind?: NotificationKind;
  userId?: string;
}

export type RetrySkipReason = 'NOT_FOUND' | 'NOT_FAILED' | 'USER_INACTIVE' | 'NOT_ADMIN' | 'UNSUPPORTED_CHANNEL' | 'JOB_IN_FLIGHT' | 'TOO_OLD';

export interface NotificationRetryResult {
  retried: number[];
  skipped: Array<{ id: number; reason: RetrySkipReason }>;
}

export const RETRY_SKIP_LABEL: Record<RetrySkipReason, string> = {
  NOT_FOUND: 'Bildirim bulunamadı',
  NOT_FAILED: 'Artık başarısız durumda değil',
  USER_INACTIVE: 'Kullanıcı aktif değil',
  NOT_ADMIN: 'Alıcı artık yönetici değil',
  UNSUPPORTED_CHANNEL: 'Bu kanal yeniden denenemiyor',
  JOB_IN_FLIGHT: 'Kuyrukta bekleyen işi zaten var',
  TOO_OLD: '7 günden eski',
};

/** API tek istekte en fazla 100 kimlik kabul eder. */
export const RETRY_MAX_IDS = 100;

export type LatencyRange = '24h' | '7d';
export interface Pct {
  p50: number | null;
  p95: number | null;
  n: number;
}
export interface AdminLatency {
  range: LatencyRange;
  byReason: Record<'NEW' | 'PRICE_DROP' | 'RELIST', Pct>;
  byChannel: Record<NotificationChannel, Pct>;
}

// ---------------------------------------------------------------- takılı eşleştirme gönderimleri

export interface StuckDispatch {
  analysisId: number;
  listingId: number;
  matchEvent: string | null;
  matchDispatchAttempts: number;
  createdAt: string;
  listing: { title: string; make: string; model: string; year: number; status: string };
}

// ---------------------------------------------------------------- ayarlar

export interface AdminSetting {
  key: SettingKey;
  /** Kayıtlı (kısmi) geçersiz kılma; kayıt yoksa null. Geçersiz olabilir: o zaman `effective` = varsayılanlar. */
  value: Record<string, unknown> | null;
  updatedAt: string | null;
  defaults: Record<string, number>;
  effective: Record<string, number>;
}

// ---------------------------------------------------------------- denetim

export interface AuditLogItem {
  id: number;
  action: string;
  actor: { id: string; email: string; name: string; role: string; status: string } | null;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

export interface AuditLogsQuery extends PageQuery {
  actor?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------- uçlar

const enc = encodeURIComponent;

export const opsApi = {
  queues: () => adminGet<AdminQueue[]>('/queues'),
  retryFailed: (name: AdminQueueName) => adminSend<{ retried: number; skipped: number }>('POST', `/queues/${enc(name)}/retry-failed`),
  cleanQueue: (name: AdminQueueName, body: AdminQueueClean) => adminSend<{ removed: number }>('POST', `/queues/${enc(name)}/clean`, body),
  workers: () => adminGet<AdminWorker[]>('/workers'),
  notifications: (q: AdminNotificationsQuery) => adminGet<Paged<AdminNotificationRow>>('/notifications', q),
  retryNotifications: (ids: number[]) => adminSend<NotificationRetryResult>('POST', '/notifications/retry', { ids }),
  latency: (range: LatencyRange) => adminGet<AdminLatency>('/notifications/latency', { range }),
  stuckDispatches: (q: PageQuery) => adminGet<Paged<StuckDispatch>>('/match-dispatches/stuck', q),
  resetDispatch: (analysisId: number) =>
    adminSend<{ analysisId: number; matchDispatchAttempts: number }>('POST', `/match-dispatches/${analysisId}/reset`),
  createPlan: (body: AdminPlanCreate) => adminSend<{ plan: AdminPlan }>('POST', '/plans', body),
  updatePlan: (id: string, body: AdminPlanUpdate) =>
    adminSend<{ plan: AdminPlan & { usersOverProfileLimit: number } }>('PATCH', `/plans/${enc(id)}`, body),
  settings: () => adminGet<{ items: AdminSetting[] }>('/settings'),
  patchSetting: (key: SettingKey, value: Record<string, number | null>) =>
    adminSend<{ setting: AdminSetting }>('PATCH', '/settings', { key, value }),
  auditLogs: (q: AuditLogsQuery) => adminGet<Paged<AuditLogItem>>('/audit-logs', q),
};

/** Kuyruk/worker uçları Redis'e ulaşamazsa 503 döner; genel 5xx metni yerine nedeni söyleriz. */
export function opsErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 503) return 'Kuyruk sunucusuna şu anda erişilemiyor. Redis bağlantısı gelince yeniden deneyin.';
  return adminErrorMessage(err);
}

// ---------------------------------------------------------------- etiketler

/** Kuyruk adları (genel bakış ve sistem izleme). */
export const QUEUE_LABEL: Record<string, string> = {
  scrape: 'Tarama',
  analyze: 'Analiz',
  match: 'Eşleştirme',
  notify: 'Bildirim',
  'notify-telegram': 'Telegram bildirimi',
};

export const EVENT_LABEL: Record<string, string> = {
  NEW: 'Yeni ilan',
  PRICE_DROP: 'Fiyat düşüşü',
  RELIST: 'Yeniden yayın',
};

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  IN_APP: 'Uygulama içi',
  TELEGRAM: 'Telegram',
  EMAIL: 'E-posta',
};

export const KIND_LABEL: Record<NotificationKind, string> = {
  MATCH: 'Eşleşme',
  SYSTEM_ALERT: 'Sistem alarmı',
  SECURITY: 'Güvenlik',
};
