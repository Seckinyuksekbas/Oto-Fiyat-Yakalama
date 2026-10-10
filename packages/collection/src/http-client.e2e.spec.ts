import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startRedis } from '@oto/testing';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BlockedError, FetchError, PoliteHttpClient, retryAfterMs, type PoliteHttpOptions } from './index';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const hits: { path: string; at: number; ua: string | undefined }[] = [];
let server: Server;
let base: string;
let redis: Redis;
let stopRedis: () => Promise<void>;

beforeAll(async () => {
  const r = await startRedis();
  stopRedis = r.stop;
  redis = new Redis(r.url);
  server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', at: Date.now(), ua: req.headers['user-agent'] });
    const h = routes.get(req.url ?? '') ?? ((_q, s) => s.writeHead(404).end('not found'));
    h(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections(); // zaman aşımı testindeki askıda bağlantılar
  await new Promise<void>((done) => server.close(() => done()));
  await redis.quit();
  await stopRedis();
});

let sourceSeq = 0;
beforeEach(async () => {
  routes.clear();
  hits.length = 0;
  await redis.flushdb();
  sourceSeq += 1;
});

const sleeps: number[] = [];
function client(over: Partial<PoliteHttpOptions> = {}) {
  sleeps.length = 0;
  return new PoliteHttpClient({
    sourceId: sourceSeq,
    minRequestGapMs: 0,
    userAgent: 'OtoFirsatBot/1.0 (+http://localhost/bot)',
    redis,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
}
const html = (body: string): Handler => (_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(body);
const pageHits = () => hits.filter((h) => h.path !== '/robots.txt');

describe('PoliteHttpClient', () => {
  it('sends the honest user agent and returns the body', async () => {
    routes.set('/p', html('<p>ok</p>'));
    const res = await client().getText(`${base}/p`);
    expect(res).toMatchObject({ status: 200, body: '<p>ok</p>' });
    expect(pageHits()[0].ua).toBe('OtoFirsatBot/1.0 (+http://localhost/bot)');
  });

  it('refuses paths disallowed by robots.txt without requesting them', async () => {
    routes.set('/robots.txt', (_q, s) => s.writeHead(200).end('User-agent: *\nDisallow: /secret\n'));
    routes.set('/secret', html('x'));
    await expect(client().getText(`${base}/secret`)).rejects.toBeInstanceOf(BlockedError);
    expect(pageHits()).toHaveLength(0);
  });

  it('caches robots.txt per origin', async () => {
    routes.set('/a', html('a'));
    routes.set('/b', html('b'));
    const c = client();
    await c.getText(`${base}/a`);
    await c.getText(`${base}/b`);
    expect(hits.filter((h) => h.path === '/robots.txt')).toHaveLength(1);
  });

  it('treats a 5xx robots.txt as a transient failure', async () => {
    routes.set('/robots.txt', (_q, s) => s.writeHead(503).end());
    await expect(client().getText(`${base}/p`)).rejects.toMatchObject({ kind: 'HTTP_5XX', transient: true });
  });

  it('retries 5xx with exponential backoff and then succeeds', async () => {
    let n = 0;
    routes.set('/flaky', (_q, s) => (++n < 3 ? s.writeHead(503).end() : s.writeHead(200).end('ok')));
    const res = await client().getText(`${base}/flaky`);
    expect(res.body).toBe('ok');
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after 3 attempts with a transient HTTP_5XX error', async () => {
    routes.set('/down', (_q, s) => s.writeHead(502).end());
    const err = await client().getText(`${base}/down`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ kind: 'HTTP_5XX', transient: true });
    expect(pageHits()).toHaveLength(3);
  });

  it('honours Retry-After and caps it at 60 seconds', async () => {
    let n = 0;
    routes.set('/limited', (_q, s) => (++n === 1 ? s.writeHead(429, { 'retry-after': '2' }).end() : s.writeHead(200).end('ok')));
    await client().getText(`${base}/limited`);
    expect(sleeps).toEqual([2000]);
    expect(retryAfterMs('3600')).toBe(60_000);
    expect(retryAfterMs(new Date(Date.now() + 5_000).toUTCString())).toBeLessThanOrEqual(5_000);
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('treats 403 as blocked and never retries it', async () => {
    routes.set('/forbidden', (_q, s) => s.writeHead(403).end());
    await expect(client().getText(`${base}/forbidden`)).rejects.toMatchObject({ kind: 'BLOCKED', transient: false });
    expect(pageHits()).toHaveLength(1);
  });

  it('detects captcha pages generically and via the adapter hook', async () => {
    routes.set('/captcha', html('<div class="g-recaptcha"></div>'));
    routes.set('/custom', html('<body data-demo-blocked></body>'));
    await expect(client().getText(`${base}/captcha`)).rejects.toBeInstanceOf(BlockedError);
    const c = client({ isBlockedPage: (h) => h.includes('data-demo-blocked') });
    await expect(c.getText(`${base}/custom`)).rejects.toBeInstanceOf(BlockedError);
  });

  it('returns 404 to the caller instead of throwing', async () => {
    expect((await client().getText(`${base}/missing`)).status).toBe(404);
  });

  it('follows redirects', async () => {
    routes.set('/old', (_q, s) => s.writeHead(301, { location: '/new' }).end());
    routes.set('/new', html('moved'));
    expect((await client().getText(`${base}/old`)).body).toBe('moved');
  });

  it('classifies a refused connection as a transient NETWORK error', async () => {
    const dead = createServer();
    await new Promise<void>((done) => dead.listen(0, '127.0.0.1', done));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((done) => dead.close(() => done()));
    await expect(client().getText(`http://127.0.0.1:${port}/x`)).rejects.toMatchObject({ kind: 'NETWORK', transient: true });
  });

  it('classifies a hanging server as a TIMEOUT', async () => {
    routes.set('/hang', () => undefined);
    await expect(client({ timeoutMs: 300 }).getText(`${base}/hang`)).rejects.toMatchObject({ kind: 'TIMEOUT', transient: true });
  });

  it('enforces the per-source gap across separate clients (shared Redis)', async () => {
    routes.set('/g', html('g'));
    const opts = { minRequestGapMs: 250, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const a = client(opts);
    const b = client(opts);
    await a.getText(`${base}/g`); // robots + ilk istek
    hits.length = 0;
    await Promise.all([a.getText(`${base}/g`), b.getText(`${base}/g`), a.getText(`${base}/g`), b.getText(`${base}/g`)]);
    const times = pageHits().map((h) => h.at).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(230);
  });

  it('tracks request stats', async () => {
    routes.set('/s', html('s'));
    const c = client();
    await c.getText(`${base}/s`);
    expect(c.stats.requests).toBe(2); // robots + sayfa
    await c.close();
  });
});
