import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startRedis } from '@oto/testing';
import Redis from 'ioredis';
import { MockAgent } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const created: PoliteHttpClient[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((c) => c.close().catch(() => undefined)));
});
function client(over: Partial<PoliteHttpOptions> = {}) {
  sleeps.length = 0;
  const c = new PoliteHttpClient({
    sourceId: sourceSeq,
    minRequestGapMs: 0,
    userAgent: 'OtoFirsatBot/1.0 (+http://localhost/bot)',
    redis,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  created.push(c);
  return c;
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
    expect(pageHits()).toHaveLength(1);
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

  it('blocks a challenge page served with a 5xx status without retrying', async () => {
    routes.set('/c503', (_q, s) => s.writeHead(503).end('<div class="g-recaptcha"></div>'));
    await expect(client().getText(`${base}/c503`)).rejects.toBeInstanceOf(BlockedError);
    expect(pageHits()).toHaveLength(1);
  });

  it('does not treat the plain word captcha as a block', async () => {
    routes.set('/plain', html('<p>Bu ilanda captcha yok</p>'));
    expect((await client().getText(`${base}/plain`)).status).toBe(200);
  });

  it('blocks a "Just a moment" interstitial', async () => {
    routes.set('/jam', html('<html><title>Just a moment...</title></html>'));
    await expect(client().getText(`${base}/jam`)).rejects.toBeInstanceOf(BlockedError);
  });

  it('treats a 429 robots.txt as transient and does not cache it', async () => {
    routes.set('/robots.txt', (_q, s) => s.writeHead(429).end());
    const c = client();
    await expect(c.getText(`${base}/p`)).rejects.toMatchObject({ kind: 'HTTP_4XX', transient: true });
    await expect(c.getText(`${base}/p`)).rejects.toMatchObject({ kind: 'HTTP_4XX', transient: true });
    expect(hits.filter((h) => h.path === '/robots.txt')).toHaveLength(2);
  });

  it('treats a 403 robots.txt as blocked', async () => {
    routes.set('/robots.txt', (_q, s) => s.writeHead(403).end());
    await expect(client().getText(`${base}/p`)).rejects.toBeInstanceOf(BlockedError);
  });

  it('obeys a group addressed to our own bot name', async () => {
    routes.set('/robots.txt', (_q, s) =>
      s.writeHead(200).end('User-agent: OtoFirsatBot\nDisallow: /bot-only\n\nUser-agent: *\nDisallow:\n'),
    );
    routes.set('/bot-only', html('x'));
    await expect(client().getText(`${base}/bot-only`)).rejects.toBeInstanceOf(BlockedError);
    expect(pageHits()).toHaveLength(0);
  });

  it('gives up on persistent 429 with a transient HTTP_4XX after 3 attempts', async () => {
    routes.set('/rl', (_q, s) => s.writeHead(429).end());
    await expect(client().getText(`${base}/rl`)).rejects.toMatchObject({ kind: 'HTTP_4XX', transient: true });
    expect(pageHits()).toHaveLength(3);
  });

  it('does not wait for a Retry-After above the cap; fails transiently at once', async () => {
    routes.set('/long', (_q, s) => s.writeHead(429, { 'retry-after': '3600' }).end());
    const err = await client().getText(`${base}/long`).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'HTTP_4XX', transient: true });
    expect((err as Error).message).toContain('Retry-After');
    expect(pageHits()).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('tracks request stats', async () => {
    routes.set('/s', html('s'));
    const c = client();
    await c.getText(`${base}/s`);
    expect(c.stats.requests).toBe(2); // robots + sayfa
    await c.close();
  });
});

describe('blockPrivateAddresses', () => {
  it('rejects a literal private IP with a non-retryable error and sends nothing', async () => {
    routes.set('/p', html('<p>ok</p>'));
    const err = await client({ blockPrivateAddresses: true }).getText(`${base}/p`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ transient: false });
    expect(hits).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it('rejects a hostname whose DNS answer is private (rebinding) at connect time', async () => {
    routes.set('/p', html('<p>ok</p>'));
    const port = new URL(base).port;
    const err = await client({
      blockPrivateAddresses: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })
      .getText(`http://rebind.test:${port}/p`)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ transient: false });
    expect(hits).toHaveLength(0);
  });

  it('guards the PROXY host too: a proxy name resolving to a private address is rejected at connect time', async () => {
    const asked: string[] = [];
    const err = await client({
      blockPrivateAddresses: true,
      proxyUrl: 'http://proxy.example:3128',
      lookup: async (host) => {
        asked.push(host);
        return [{ address: '10.0.0.5', family: 4 }];
      },
    })
      .getText('http://93.184.216.34/p')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ transient: false });
    expect(asked).toContain('proxy.example');
    expect(hits).toHaveLength(0);
  });

  it('rejects a redirect hop that points at a private IP', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get('http://public.example');
    pool.intercept({ path: '/robots.txt' }).reply(404, '');
    pool.intercept({ path: '/start' }).reply(302, '', { headers: { location: `${base}/secret` } });
    routes.set('/secret', html('secret'));
    const err = await client({ blockPrivateAddresses: true, dispatcher: mock }).getText('http://public.example/start').catch((e: unknown) => e);
    expect(err).toMatchObject({ transient: false });
    expect((err as Error).message).toContain('iç ağ');
    expect(hits).toHaveLength(0);
  });

  it('follows a redirect between public hosts when blocking is on', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get('http://public.example');
    pool.intercept({ path: '/robots.txt' }).reply(404, '');
    pool.intercept({ path: '/start' }).reply(302, '', { headers: { location: '/end' } });
    pool.intercept({ path: '/end' }).reply(200, 'landed');
    const res = await client({ blockPrivateAddresses: true, dispatcher: mock }).getText('http://public.example/start');
    expect(res.body).toBe('landed');
  });

  describe('IPv6 literals', () => {
    let v6: Server;
    let v6Port: number;
    const v6Hits: string[] = [];
    beforeAll(async () => {
      v6 = createServer((req, res) => {
        v6Hits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/html' }).end('v6-secret');
      });
      await new Promise<void>((done) => v6.listen(0, '::1', done));
      v6Port = (v6.address() as AddressInfo).port;
    });
    afterAll(async () => {
      v6.closeAllConnections();
      await new Promise<void>((done) => v6.close(() => done()));
    });
    beforeEach(() => {
      v6Hits.length = 0;
    });

    it('rejects a redirect hop to a bracketed IPv6 loopback literal', async () => {
      const mock = new MockAgent(); // eşleşmeyen istekler gerçek ağa gider (IPv6 sunucusu)
      const pool = mock.get('http://public.example');
      pool.intercept({ path: '/robots.txt' }).reply(404, '');
      pool.intercept({ path: '/start' }).reply(302, '', { headers: { location: `http://[::1]:${v6Port}/secret` } });
      const err = await client({ blockPrivateAddresses: true, dispatcher: mock }).getText('http://public.example/start').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FetchError);
      expect(err).toMatchObject({ transient: false });
      expect((err as Error).message).toContain('iç ağ');
      expect(v6Hits).toHaveLength(0);
      await mock.close();
    });

    it('rejects a direct request to a bracketed IPv6 loopback literal', async () => {
      const err = await client({ blockPrivateAddresses: true }).getText(`http://[::1]:${v6Port}/p`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FetchError);
      expect(err).toMatchObject({ transient: false });
      expect((err as Error).message).toContain('iç ağ');
      expect(v6Hits).toHaveLength(0);
    });

    it('rejects an IPv4-mapped IPv6 literal pointing at loopback', async () => {
      const port = new URL(base).port;
      const err = await client({ blockPrivateAddresses: true }).getText(`http://[::ffff:127.0.0.1]:${port}/p`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FetchError);
      expect(err).toMatchObject({ transient: false });
      expect((err as Error).message).toContain('iç ağ');
      expect(hits).toHaveLength(0);
    });

    it('rejects a proxy given as a private IP literal (undici skips lookup for literals)', async () => {
      const err = await client({ blockPrivateAddresses: true, proxyUrl: `http://[::1]:${v6Port}` })
        .getText('http://93.184.216.34/p')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FetchError);
      expect(err).toMatchObject({ transient: false });
      expect((err as Error).message).toContain('iç ağ');
      expect(v6Hits).toHaveLength(0);
    });

    it('rejects an IPv4-mapped link-local (metadata) literal on a redirect hop', async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      const pool = mock.get('http://public.example');
      pool.intercept({ path: '/robots.txt' }).reply(404, '');
      pool.intercept({ path: '/start' }).reply(302, '', { headers: { location: 'http://[::ffff:a9fe:a9fe]/latest/meta-data' } });
      const err = await client({ blockPrivateAddresses: true, dispatcher: mock }).getText('http://public.example/start').catch((e: unknown) => e);
      expect(err).toMatchObject({ transient: false });
      expect((err as Error).message).toContain('iç ağ');
      await mock.close();
    });
  });

  it('keeps current behaviour (local targets allowed) when the flag is off', async () => {
    routes.set('/p', html('<p>ok</p>'));
    expect((await client({ blockPrivateAddresses: false }).getText(`${base}/p`)).body).toBe('<p>ok</p>');
  });
});
