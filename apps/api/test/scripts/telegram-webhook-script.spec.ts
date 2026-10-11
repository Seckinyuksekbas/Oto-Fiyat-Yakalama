import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../scripts/telegram-webhook.mjs');
// Token biçimli literal yazılmaz; çalışma anında üretilir.
const TOKEN = ['123456789', 'TEST'.padEnd(35, 'x')].join(':');
const SECRET = 'webhook_secret_'.padEnd(48, 'z');

type Recorded = { url: string; body: Record<string, unknown> };
const requests: Recorded[] = [];
let next: { status: number; body: unknown } | undefined;
let server: Server;
let apiBase = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      const r = next ?? { status: 200, body: { ok: true, result: req.url?.endsWith('/getWebhookInfo') ? { url: 'https://oto.example.com/api/v1/telegram/webhook', pending_update_count: 0 } : true } };
      next = undefined;
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(() => {
  requests.length = 0;
  next = undefined;
});

function run(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: base, timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const fullEnv = () => ({
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  PUBLIC_BASE_URL: 'https://oto.example.com/',
  TELEGRAM_API_BASE: apiBase,
});

describe('scripts/telegram-webhook.mjs', () => {
  it('set: posts setWebhook with url, secret_token and allowed_updates; never prints the token or secret', async () => {
    const r = await run(['set'], fullEnv());
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`/bot${TOKEN}/setWebhook`);
    expect(requests[0].body).toEqual({
      url: 'https://oto.example.com/api/v1/telegram/webhook',
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    });
    const out = r.stdout + r.stderr;
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TOKEN.split(':')[1]);
    expect(out).not.toContain(SECRET);
    expect(r.stdout).toContain('https://oto.example.com/api/v1/telegram/webhook');
  });

  it('info: calls getWebhookInfo and prints the result', async () => {
    const r = await run(['info'], { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: apiBase });
    expect(r.code).toBe(0);
    expect(requests.map((q) => q.url)).toEqual([`/bot${TOKEN}/getWebhookInfo`]);
    expect(r.stdout).toContain('pending_update_count');
    expect(r.stdout + r.stderr).not.toContain(TOKEN.split(':')[1]);
  });

  it('delete: calls deleteWebhook without dropping pending updates', async () => {
    const r = await run(['delete'], { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: apiBase });
    expect(r.code).toBe(0);
    expect(requests).toEqual([{ url: `/bot${TOKEN}/deleteWebhook`, body: { drop_pending_updates: false } }]);
  });

  it('exits 1 on missing env without calling the API', async () => {
    for (const missing of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL'] as const) {
      const env: Record<string, string | undefined> = fullEnv();
      delete env[missing];
      const r = await run(['set'], env);
      expect(r.code, missing).toBe(1);
      expect(r.stderr).toContain(missing);
      expect(r.stdout + r.stderr).not.toContain(TOKEN.split(':')[1]);
    }
    expect(requests).toHaveLength(0);
  });

  it('rejects a secret shorter than 32 chars (same rule as the api env) without calling the API', async () => {
    const r = await run(['set'], { ...fullEnv(), TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(31) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('32-256');
    expect(requests).toHaveLength(0);
  });

  it('masks trimmed values: a whitespace-padded token is sent trimmed and never printed', async () => {
    next = { status: 400, body: { ok: false, error_code: 400, description: `bad token ${TOKEN} and secret ${SECRET}` } };
    const r = await run(['set'], { ...fullEnv(), TELEGRAM_BOT_TOKEN: `  ${TOKEN}  `, TELEGRAM_WEBHOOK_SECRET: ` ${SECRET} ` });
    expect(r.code).toBe(1);
    expect(requests[0].url).toBe(`/bot${TOKEN}/setWebhook`);
    expect(requests[0].body.secret_token).toBe(SECRET);
    const out = r.stdout + r.stderr;
    expect(out).not.toContain(TOKEN.split(':')[1]);
    expect(out).not.toContain(SECRET);
  });

  it('exits 1 on an unknown command', async () => {
    const r = await run(['nope'], fullEnv());
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it('exits 1 on a non-ok API response and masks the token in the error', async () => {
    next = { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` } };
    const r = await run(['set'], fullEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('401');
    expect(r.stdout + r.stderr).not.toContain(TOKEN.split(':')[1]);
  });

  it('exits 1 when the API is unreachable, without leaking the token-bearing URL', async () => {
    const r = await run(['info'], { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: 'http://127.0.0.1:1' });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(TOKEN.split(':')[1]);
  });
});
