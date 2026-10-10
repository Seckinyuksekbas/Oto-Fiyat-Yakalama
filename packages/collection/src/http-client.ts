import type Redis from 'ioredis';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { BlockedError, FetchError, toFetchError } from './errors';
import { SourceRateLimiter } from './rate-limiter';
import { RobotsCache } from './robots';

export interface HttpResult {
  status: number;
  body: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpFetcher {
  getText(url: string): Promise<HttpResult>;
}

export interface PoliteHttpOptions {
  sourceId: number;
  minRequestGapMs: number;
  userAgent: string;
  redis: Redis;
  /** Sabit çıkış proxy'si (ör. partnerin IP beyaz listesi). Engellere tepki olarak döndürülmez. */
  proxyUrl?: string | null;
  maxAttempts?: number;
  timeoutMs?: number;
  isBlockedPage?: (html: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const GENERIC_BLOCK_MARKERS =
  /class=["'][^"']*b(g-recaptcha|h-captcha|cf-turnstile)b|cf-chl-|challenge-platform|<title>[^<]*(attention required|just a moment)/i;
const MAX_RETRY_AFTER_MS = 60_000;

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoff(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

export function retryAfterMs(header: string | string[] | undefined, now = Date.now()): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Bir kaynağa yapılan TÜM ağ erişiminin tek giriş noktası: robots.txt, hız limiti,
 * zaman aşımları, geçici hatalarda yeniden deneme ve engel tespiti burada uygulanır.
 */
export class PoliteHttpClient implements HttpFetcher {
  readonly stats = { requests: 0, totalMs: 0 };
  private readonly dispatcher: Dispatcher;
  private readonly limiter: SourceRateLimiter;
  private readonly robots: RobotsCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly opts: PoliteHttpOptions) {
    const timeout = opts.timeoutMs ?? 30_000;
    const agentOptions = { connect: { timeout: 10_000 }, headersTimeout: timeout, bodyTimeout: timeout };
    this.dispatcher = opts.proxyUrl ? new ProxyAgent({ uri: opts.proxyUrl, ...agentOptions }) : new Agent(agentOptions);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.limiter = new SourceRateLimiter(opts.redis, opts.sourceId, opts.minRequestGapMs, this.sleep);
    this.robots = new RobotsCache(opts.redis, opts.userAgent, (url) => this.fetchOnce(url));
  }

  async getText(url: string): Promise<HttpResult> {
    if (!(await this.robots.isAllowed(url))) {
      throw new BlockedError(`robots.txt bu adrese izin vermiyor: ${url}`, url);
    }
    const res = await this.fetchWithRetry(url);
    if (res.status === 403) throw new BlockedError(`Kaynak erişimi reddetti (HTTP 403): ${url}`, url);
    if (res.status === 200 && this.isBlocked(res.body)) {
      throw new BlockedError(`Bot doğrulama sayfası algılandı: ${url}`, url);
    }
    return res;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private isBlocked(body: string): boolean {
    return GENERIC_BLOCK_MARKERS.test(body) || (this.opts.isBlockedPage?.(body) ?? false);
  }

  private async fetchWithRetry(url: string): Promise<HttpResult> {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= this.maxAttempts;
      let res: HttpResult;
      try {
        res = await this.fetchOnce(url);
      } catch (err) {
        const fe = toFetchError(err, url);
        if (last || !fe.transient) throw fe;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (this.isBlocked(res.body)) throw new BlockedError(`Bot doğrulama sayfası algılandı (HTTP ${res.status}): ${url}`, url);
        if (last) throw new FetchError(res.status === 429 ? 'HTTP_4XX' : 'HTTP_5XX', `HTTP ${res.status}: ${url}`, url, true);
        await this.sleep(retryAfterMs(res.headers['retry-after']) ?? backoff(attempt));
        continue;
      }
      return res;
    }
  }

  private async fetchOnce(url: string): Promise<HttpResult> {
    await this.limiter.acquire();
    const started = Date.now();
    const res = await request(url, {
      method: 'GET',
      dispatcher: this.dispatcher,
      maxRedirections: 3,
      headers: { 'user-agent': this.opts.userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
    });
    const body = await res.body.text();
    this.stats.requests += 1;
    this.stats.totalMs += Date.now() - started;
    return { status: res.statusCode, body, url, headers: res.headers };
  }
}
