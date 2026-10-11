import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@oto/db';
import { FakeTelegramApi } from '@oto/telegram';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { TelegramPollingService } from '../src/modules/telegram/telegram-polling.service';
import { TelegramUpdateHandler } from '../src/modules/telegram/telegram-update.handler';
import { createTestApp, newAgent, registerUser, resetState, verifyEmail } from './helpers';

const SECRET = 'w'.repeat(40);
const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_MODE', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_API_BASE'];

let app: NestExpressApplication;
let fake: FakeTelegramApi;
let prisma: PrismaService;

beforeAll(async () => {
  fake = new FakeTelegramApi();
  const { apiBase, token } = await fake.start();
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_BOT_USERNAME: 'otofirsat_test_bot',
    TELEGRAM_MODE: 'webhook',
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_API_BASE: apiBase,
  });
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
  await fake.close();
  for (const k of ENV_KEYS) delete process.env[k];
});
beforeEach(async () => {
  await resetState(app);
  fake.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const hook = (body: object) =>
  newAgent(app).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(body);
const startUpdate = (chatId: number, code: string, updateId: number) => ({
  update_id: updateId,
  message: { chat: { id: chatId, type: 'private' }, text: `/start ${code}` },
});
const sent = () => fake.requests.filter((r) => r.method === 'sendMessage');
const channelCount = () => prisma.notificationChannel.count({ where: { type: 'TELEGRAM' } });

async function newCode(): Promise<string> {
  const u = await registerUser(app);
  await verifyEmail(app, u.user.id);
  const res = await u.agent.post('/api/v1/me/channels/telegram/link');
  expect(res.status).toBe(201);
  return new URL(res.body.deepLink).searchParams.get('start') as string;
}

function dbUnreachable(): Error {
  return new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' });
}

describe('Telegram webhook failure semantics', () => {
  it('handler failure answers 500 so Telegram retries the update', async () => {
    vi.spyOn(app.get(TelegramUpdateHandler), 'handle').mockRejectedValueOnce(new Error('boom'));
    const res = await hook({ update_id: 10, message: { chat: { id: 1, type: 'private' }, text: 'hi' } });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it('transient DB error while linking: no "kod geçersiz" message, 500, and the retry links', async () => {
    const code = await newCode();
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(dbUnreachable());

    const res = await hook(startUpdate(555, code, 20));
    expect(res.status).toBe(500);
    expect(sent()).toHaveLength(0);
    expect(await channelCount()).toBe(0);

    // Telegram aynı update_id ile yeniden dener: tekilleştirme anahtarı bırakılmış olmalı.
    const retry = await hook(startUpdate(555, code, 20));
    expect(retry.status).toBe(200);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toContain('✅');
    expect(await channelCount()).toBe(1);
  });

  it('a genuinely invalid code still answers 200 with the "geçersiz" reply', async () => {
    const res = await hook(startUpdate(556, 'B'.repeat(22), 21));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toContain('geçersiz');
  });
});

describe('Telegram polling failure semantics', () => {
  const offsets = () => fake.requests.filter((r) => r.method === 'getUpdates').map((r) => Number(r.body.offset));
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !(await cond())) await new Promise((r) => setTimeout(r, 25));
  };

  it('does not advance the offset past a failing update; retries it until it succeeds', async () => {
    const code = await newCode();
    const handler = app.get(TelegramUpdateHandler);
    const spy = vi.spyOn(handler, 'handle').mockRejectedValueOnce(dbUnreachable()).mockRejectedValueOnce(dbUnreachable());
    const polling = app.get(TelegramPollingService);
    polling.handlerRetryBaseMs = 20;
    fake.queueUpdates([startUpdate(777, code, 50)]);
    polling.start();
    try {
      await waitFor(async () => (await channelCount()) === 1);
      expect(await channelCount()).toBe(1);
      expect(spy).toHaveBeenCalledTimes(3);
      await waitFor(() => offsets().includes(51));
      const os = offsets();
      // 51'e geçmeden önce yalnızca 0 (ilk) ve 50 (yeniden deneme) istenmiş olmalı
      expect(os.slice(0, os.indexOf(51))).toEqual(expect.arrayContaining([0]));
      expect(os.slice(0, os.indexOf(51)).every((o) => o === 0 || o === 50)).toBe(true);
      expect(sent().filter((m) => String(m.body.text).includes('geçersiz'))).toHaveLength(0);
    } finally {
      await polling.stop();
    }
  });

  it('skips a poison update after maxHandlerAttempts and continues with the next one', async () => {
    const code = await newCode();
    const handler = app.get(TelegramUpdateHandler);
    const real = handler.handle.bind(handler);
    const spy = vi.spyOn(handler, 'handle').mockImplementation(async (u) => {
      if (u.update_id === 60) throw new Error('poison');
      return real(u);
    });
    const polling = app.get(TelegramPollingService);
    polling.handlerRetryBaseMs = 10;
    fake.queueUpdates([{ update_id: 60, message: { chat: { id: 1, type: 'private' }, text: 'x' } }, startUpdate(778, code, 61)]);
    polling.start();
    try {
      await waitFor(async () => (await channelCount()) === 1);
      expect(await channelCount()).toBe(1);
      expect(spy.mock.calls.filter(([u]) => u.update_id === 60)).toHaveLength(polling.maxHandlerAttempts);
      expect(polling.maxHandlerAttempts).toBe(5);
    } finally {
      await polling.stop();
    }
  });
});
