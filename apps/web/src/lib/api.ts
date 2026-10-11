export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type QueryValue = string | number | boolean | undefined;
export interface ApiInit extends Omit<RequestInit, 'body'> {
  json?: unknown;
  query?: Record<string, QueryValue>;
  body?: BodyInit | null;
  /** true: 401'de oturum yenileme denenmez (ör. giriş sayfasındaki oturum kontrolü). */
  noRefresh?: boolean;
}

const API_PREFIX = '/api/v1';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REFRESHABLE = new Set(['UNAUTHENTICATED', 'TOKEN_INVALID']);

export type ExpiredReason = 'reused';
const EXPIRED_DEDUPE_MS = 2000;

function defaultSessionExpired(reason?: ExpiredReason): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname === '/giris') return; // giriş sayfasında döngü olmasın
  const r = reason ? `&reason=${reason}` : '';
  window.location.assign(`/giris?next=${encodeURIComponent(pathname + search)}${r}`);
}

let sessionExpiredHandler: (reason?: ExpiredReason) => void = defaultSessionExpired;
let lastExpiredAt = -Infinity;

/** `null` varsayılan işleyiciyi geri yükler. */
export function setSessionExpiredHandler(fn: ((reason?: ExpiredReason) => void) | null): void {
  sessionExpiredHandler = fn ?? defaultSessionExpired;
  lastExpiredAt = -Infinity;
}

/** Eşzamanlı isteklerin hepsi başarısız olsa da işleyici 2 sn'de bir kez çalışır. */
function notifyExpired(reason?: ExpiredReason): void {
  const now = Date.now();
  if (now - lastExpiredAt < EXPIRED_DEDUPE_MS) return;
  lastExpiredAt = now;
  sessionExpiredHandler(reason);
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const url = new URL(`${API_PREFIX}${path}`, origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = 'INTERNAL';
  let message = res.statusText || 'İstek başarısız';
  let details: unknown;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    /* gövde JSON değil */
  }
  return new ApiError(res.status, code, message, details);
}

async function send(path: string, init: ApiInit): Promise<Response> {
  const { json, query, headers, method = 'GET', noRefresh: _noRefresh, ...rest } = init;
  const h = new Headers(headers);
  if (!SAFE_METHODS.has(method.toUpperCase())) h.set('X-Requested-With', 'XMLHttpRequest');
  let body = rest.body;
  if (json !== undefined) {
    h.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  return fetch(buildUrl(path, query), { ...rest, method, headers: h, body, credentials: 'include' });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RefreshOutcome = { kind: 'ok' } | { kind: 'expired'; reason?: ExpiredReason } | { kind: 'transient' };

/**
 * Yalnızca 401 sonuçları (TOKEN_INVALID, REFRESH_REUSED, ikinci REFRESH_RACE) oturum bitti sayılır.
 * Ağ hatası, 5xx ve 429 geçicidir: kullanıcı oturumdan atılmaz.
 */
async function doRefresh(): Promise<RefreshOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await send('/auth/refresh', { method: 'POST' });
    } catch {
      return { kind: 'transient' };
    }
    if (res.ok) return { kind: 'ok' };
    if (res.status !== 401) return { kind: 'transient' };
    const err = await toApiError(res);
    if (err.code === 'REFRESH_RACE' && attempt === 0) {
      await sleep(300);
      continue;
    }
    return err.code === 'REFRESH_REUSED' ? { kind: 'expired', reason: 'reused' } : { kind: 'expired' };
  }
  return { kind: 'expired' };
}

let inflight: Promise<RefreshOutcome> | null = null;

function refreshOutcome(): Promise<RefreshOutcome> {
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Tek uçuşta oturum yenileme; eşzamanlı çağrılar aynı promise'i paylaşır. */
export async function refreshSessionDetailed(): Promise<'ok' | 'expired' | 'transient'> {
  return (await refreshOutcome()).kind;
}

export async function refreshSession(): Promise<boolean> {
  return (await refreshSessionDetailed()) === 'ok';
}

export async function apiFetch<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  let res = await send(path, init);

  if (res.status === 401 && !path.startsWith('/auth/') && !init.noRefresh) {
    const err = await toApiError(res);
    if (!REFRESHABLE.has(err.code)) throw err;
    const outcome = await refreshOutcome();
    if (outcome.kind === 'transient') throw err;
    if (outcome.kind === 'expired') {
      notifyExpired(outcome.reason);
      throw err;
    }
    res = await send(path, init);
    if (res.status === 401) {
      notifyExpired();
      throw await toApiError(res);
    }
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
