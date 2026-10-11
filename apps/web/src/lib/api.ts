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
}

const API_PREFIX = '/api/v1';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REFRESHABLE = new Set(['UNAUTHENTICATED', 'TOKEN_INVALID']);

function defaultSessionExpired(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname === '/giris') return; // giriş sayfasında döngü olmasın
  window.location.assign(`/giris?next=${encodeURIComponent(pathname + search)}`);
}

let sessionExpiredHandler: () => void = defaultSessionExpired;

/** `null` varsayılan işleyiciyi geri yükler. */
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  sessionExpiredHandler = fn ?? defaultSessionExpired;
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
  const { json, query, headers, method = 'GET', ...rest } = init;
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

async function doRefresh(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await send('/auth/refresh', { method: 'POST' });
    } catch {
      return false;
    }
    if (res.ok) return true;
    const err = await toApiError(res);
    if (err.code === 'REFRESH_RACE' && attempt === 0) {
      await sleep(300);
      continue;
    }
    return false;
  }
  return false;
}

let inflight: Promise<boolean> | null = null;

/** Tek uçuşta oturum yenileme; eşzamanlı çağrılar aynı promise'i paylaşır. */
export function refreshSession(): Promise<boolean> {
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function apiFetch<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  let res = await send(path, init);

  if (res.status === 401 && !path.startsWith('/auth/')) {
    const err = await toApiError(res);
    if (!REFRESHABLE.has(err.code)) throw err;
    if (!(await refreshSession())) {
      sessionExpiredHandler();
      throw err;
    }
    res = await send(path, init);
    if (res.status === 401) {
      sessionExpiredHandler();
      throw await toApiError(res);
    }
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
