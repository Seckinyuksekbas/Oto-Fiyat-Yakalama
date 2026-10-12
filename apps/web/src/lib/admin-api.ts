import type { AdminSubscription, PlanLimits } from '@oto/shared';
import { ErrorCode } from '@oto/shared';
import { ApiError, apiFetch, type QueryValue } from './api';
import { NETWORK_MESSAGE, RATE_LIMIT_MESSAGE } from './messages';

/**
 * Admin API istemcisi (`/api/v1/admin/*`). Tüm çağrılar `apiFetch` üzerinden gider: oturum yenileme, CSRF başlığı ve
 * hata zarfı (`{ error: { code, message, details } }` → `ApiError`) orada çözülür.
 *
 * Task 11–12 için: yeni uçlar `adminGet` / `adminSend` ile eklenir, tipler bu dosyada tutulur; hata metni için
 * `adminErrorMessage`, form alanı hataları için `adminFieldErrors` kullanılır.
 */

// ---------------------------------------------------------------- ortak tipler

export type AdminRole = 'USER' | 'ADMIN' | 'SUPER_ADMIN';
export type AdminUserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

/** Admin listeleri offset sayfalıdır (spec §7). */
export interface Paged<T> {
  items: T[];
  total: number;
}

export interface PageQuery {
  page: number;
  pageSize: number;
}

export const ADMIN_PAGE_SIZE = 20;

export function isAdminRole(role: unknown): role is 'ADMIN' | 'SUPER_ADMIN' {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

// ---------------------------------------------------------------- düşük seviye

/** Boş dizgeleri ve `undefined` değerleri sorgudan atar (API `.strict()` şemaları boş değeri reddeder). */
export function cleanQuery(q: object): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function adminGet<T>(path: string, query?: object): Promise<T> {
  return apiFetch<T>(`/admin${path}`, query ? { query: cleanQuery(query) } : {});
}

export function adminSend<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, json?: unknown): Promise<T> {
  return apiFetch<T>(`/admin${path}`, json === undefined ? { method } : { method, json });
}

// ---------------------------------------------------------------- genel bakış

export interface AdminSourceHealth {
  id: number;
  code: string;
  health: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'PAUSED' | string;
  /** false: yönetici duraklatması (health=PAUSED ise engel). */
  isActive: boolean;
  permissionVerifiedAt: string | null;
  lastSuccessAt: string | null;
}

/** SSE `kpi` olayı ve genel bakışın Redis'e bağlı alt kümesi. `queues`/`workers` Redis'e erişilemezse null. */
export interface AdminKpi {
  notifications: { sentToday: number; failedToday: number; skippedLimitToday: number };
  queues: Record<string, number> | null;
  workers: { alive: number; dead: number } | null;
  sources: AdminSourceHealth[];
}

export interface AdminOverview extends AdminKpi {
  users: { total: number; active: number; suspended: number; newToday: number };
  profiles: { active: number };
  listings: { active: number; newToday: number; removedToday: number };
  opportunities: { count: number };
  /** ms; son 24 saatte gönderilen MATCH bildirimleri. Veri yoksa null. */
  latency: { p50: number | null; p95: number | null };
}

export interface SystemLogItem {
  id: number;
  level: 'WARN' | 'ERROR';
  component: string;
  message: string;
  context: unknown;
  createdAt: string;
}

export interface SystemLogsQuery extends Partial<PageQuery> {
  level?: 'WARN' | 'ERROR';
  component?: string;
  q?: string;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------- kullanıcılar

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: AdminUserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  planCode: string;
}

export interface AdminUsersQuery extends PageQuery {
  q?: string;
  status?: AdminUserStatus;
  role?: AdminRole;
  plan?: string;
}

export interface AdminUserDetail {
  user: Omit<AdminUserRow, 'planCode'>;
  subscription: {
    planCode: string;
    planName: string;
    status: string;
    endsAt: string | null;
    limitOverrides: Partial<PlanLimits> | null;
  } | null;
  counts: { searchProfiles: number; activeSessions: number };
}

export interface AdminUserUsage {
  searchProfiles: number;
  activeProfiles: number;
  notificationsToday: number;
  matches7d: number;
  plan: { code: string; name: string; status: string; endsAt: string | null; limits: PlanLimits };
}

export interface AdminSearchProfile {
  id: string;
  name: string;
  status: string;
  make: string | null;
  model: string | null;
  channels: string[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface AdminUserNotification {
  id: number;
  kind: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  payload: unknown;
  sentAt: string | null;
  readAt: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface AdminPlan {
  id: string;
  code: string;
  name: string;
  priceMonthly: number;
  isActive: boolean;
  limits: PlanLimits;
  activeSubscriptions: number;
  createdAt: string;
  updatedAt: string;
}

type UserResult = { user: Omit<AdminUserRow, 'planCode' | 'lastLoginAt'> };

export const adminApi = {
  overview: () => adminGet<AdminOverview>('/overview'),
  systemLogs: (q: SystemLogsQuery) => adminGet<Paged<SystemLogItem>>('/system-logs', q),
  plans: () => adminGet<Paged<AdminPlan>>('/plans'),
  users: {
    list: (q: AdminUsersQuery) => adminGet<Paged<AdminUserRow>>('/users', q),
    get: (id: string) => adminGet<AdminUserDetail>(`/users/${encodeURIComponent(id)}`),
    usage: (id: string) => adminGet<AdminUserUsage>(`/users/${encodeURIComponent(id)}/usage`),
    searchProfiles: (id: string) => adminGet<{ items: AdminSearchProfile[] }>(`/users/${encodeURIComponent(id)}/search-profiles`),
    notifications: (id: string, q: PageQuery) =>
      adminGet<Paged<AdminUserNotification>>(`/users/${encodeURIComponent(id)}/notifications`, q),
    rename: (id: string, name: string) => adminSend<UserResult>('PATCH', `/users/${encodeURIComponent(id)}`, { name }),
    suspend: (id: string) => adminSend<UserResult>('POST', `/users/${encodeURIComponent(id)}/suspend`),
    activate: (id: string) => adminSend<UserResult>('POST', `/users/${encodeURIComponent(id)}/activate`),
    /** SUPER_ADMIN */
    setRole: (id: string, role: AdminRole) => adminSend<UserResult>('PATCH', `/users/${encodeURIComponent(id)}/role`, { role }),
    /** SUPER_ADMIN; kişisel veriler anonimleştirilir */
    remove: (id: string) => adminSend<UserResult>('DELETE', `/users/${encodeURIComponent(id)}`),
    setSubscription: (id: string, body: AdminSubscription) =>
      adminSend<{ planCode: string; pausedProfiles: number }>('PATCH', `/users/${encodeURIComponent(id)}/subscription`, body),
  },
};

// ---------------------------------------------------------------- hata eşleme

const GENERIC = 'İşlem tamamlanamadı. Biraz sonra tekrar deneyin.';

const ADMIN_CODE_MESSAGES: Partial<Record<string, string>> = {
  [ErrorCode.FORBIDDEN]: 'Bu işlem için yetkiniz yok.',
  [ErrorCode.NOT_FOUND]: 'Kayıt bulunamadı. Silinmiş ya da hiç var olmamış olabilir.',
  [ErrorCode.RATE_LIMITED]: RATE_LIMIT_MESSAGE,
  [ErrorCode.VALIDATION_FAILED]: 'Girilen bilgileri kontrol edin.',
  [ErrorCode.CSRF_REJECTED]: 'İstek doğrulanamadı. Sayfayı yenileyip tekrar deneyin.',
  [ErrorCode.UNAUTHENTICATED]: 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  [ErrorCode.TOKEN_INVALID]: 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  [ErrorCode.FEATURE_DISABLED]: 'Bu özellik şu anda kapalı.',
  [ErrorCode.LIMIT_REACHED]: 'Limit doldu.',
};

/**
 * `ApiError` → Türkçe kullanıcı mesajı. 409 `INVALID_OPERATION` yanıtları sunucunun kendi Türkçe açıklamasını taşır
 * ("Son süper admin askıya alınamaz", "Kendi aboneliğinizi değiştiremezsiniz", "Pasif pakete abonelik atanamaz");
 * bunlar aynen gösterilir. 5xx gövdeleri asla gösterilmez.
 */
export function adminErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return NETWORK_MESSAGE;
  if (err.status === 429) return RATE_LIMIT_MESSAGE;
  if (err.code === ErrorCode.INVALID_OPERATION && err.status === 409) return err.message || GENERIC;
  if (err.status >= 500) return GENERIC;
  const serverText = detaillessValidationMessage(err);
  if (serverText) return serverText;
  return ADMIN_CODE_MESSAGES[err.code] ?? GENERIC;
}

/**
 * Servis içi 400'ler (SSRF, bilinmeyen adapter, proxy bulunamadı) `VALIDATION_FAILED` + ayrıntısız + Türkçe mesaj
 * döner; ZodPipe 400'leri ise ayrıntı listesi taşır. Ayrıntısız olanların sunucu mesajı gösterilebilir.
 */
export function detaillessValidationMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== ErrorCode.VALIDATION_FAILED || err.status !== 400) return null;
  const empty = err.details === undefined || err.details === null || (Array.isArray(err.details) && err.details.length === 0);
  return empty && typeof err.message === 'string' && err.message.trim() !== '' ? err.message : null;
}

/**
 * 400 `VALIDATION_FAILED` ayrıntılarını alan yolu → mesaj eşlemesine çevirir. API iki biçim döndürür:
 * ZodPipe `{ path: 'a.b' }`, servis içi doğrulama `{ path: ['a','b'] }`; ikisi de `a.b` anahtarına normalize edilir.
 */
export function adminFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== ErrorCode.VALIDATION_FAILED || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as Array<{ path?: unknown; message?: unknown }>) {
    const key = Array.isArray(d.path) ? d.path.join('.') : typeof d.path === 'string' ? d.path : '';
    if (typeof d.message === 'string' && !(key in out)) out[key] = d.message;
  }
  return out;
}
