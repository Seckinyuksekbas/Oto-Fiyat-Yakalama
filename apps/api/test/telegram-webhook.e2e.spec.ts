import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@oto/db';
import { hashToken } from '@oto/server-common';
import { FakeTelegramApi } from '@oto/telegram';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { HANDLER_MAX_ATTEMPTS } from '../src/modules/telegram/telegram-errors';
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

/**
 * Bir sonraki interaktif tx'i GERÇEKTEN açar, ama içindeki notificationChannel.upsert çağrısını `err` ile patlatır.
 * Böylece önceki adımlar (ör. telegramLinkToken.usedAt yazımı) gerçek bir rollback'e uğrar.
 */
function failUpsertInNextTx(err: Error) {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
  const wrapTx = (tx: object) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'notificationChannel') return value;
        return new Proxy(value as object, {
          get(t, p, r) {
            if (p === 'upsert') return async () => Promise.reject(err);
            return Reflect.get(t, p, r);
          },
        });
      },
    });
  return vi
    .spyOn(prisma, '$transaction')
    .mockImplementationOnce(((fn: (tx: object) => Promise<unknown>, opts?: unknown) => original((tx: object) => fn(wrapTx(tx)), opts)) as never);
}

describe('Telegram webhook failure semantics', () => {
  it('handler failure answers 500 so Telegram retries the update', async () => {
    vi.spyOn(app.get(TelegramUpdateHandler), 'handle').mockRejectedValueOnce(new Error('boom'));
    const res = await hook({ update_id: 10, message: { chat: { id: 1, type: 'private' }, text: 'hi' } });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it('transient DB error inside the link tx: rolls back, no "kod geçersiz", 500, and the retry links', async () => {
    const code = await newCode();
    failUpsertInNextTx(dbUnreachable());

    const res = await hook(startUpdate(555, code, 20));
    expect(res.status).toBe(500);
    expect(sent()).toHaveLength(0);
    expect(await channelCount()).toBe(0);
    // usedAt yazımı tx ile birlikte geri alınmış olmalı
    const token = await prisma.telegramLinkToken.findUniqueOrThrow({ where: { codeHash: hashToken(code) } });
    expect(token.usedAt).toBeNull();
    expect(await app.get(RedisService).get('tg:update:fail:20')).toBe('1');

    // Telegram aynı update_id ile yeniden dener: tekilleştirme anahtarı bırakılmış olmalı.
    const retry = await hook(startUpdate(555, code, 20));
    expect(retry.status).toBe(200);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toContain('✅');
    expect(await channelCount()).toBe(1);
    // başarıda hata sayacı temizlenir
    expect(await app.get(RedisService).get('tg:update:fail:20')).toBeNull();
  });

  it('permanent (deterministic) error while linking: generic reply, 200, no retry storm', async () => {
    const code = await newCode();
    failUpsertInNextTx(new Prisma.PrismaClientValidationError('Invalid argument', { clientVersion: 'test' }));

    const res = await hook(startUpdate(557, code, 22));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toBe('İşlem şu anda tamamlanamadı, lütfen tekrar deneyin.');
    expect(await channelCount()).toBe(0);
  });

  it('a poison update gets HANDLER_MAX_ATTEMPTS-1 x 500, then 200 and an ERROR SystemLog row', async () => {
    vi.spyOn(app.get(TelegramUpdateHandler), 'handle').mockRejectedValue(dbUnreachable());
    const body = { update_id: 30, message: { chat: { id: 1, type: 'private' }, text: 'hi' } };
    const statuses: number[] = [];
    for (let i = 0; i < HANDLER_MAX_ATTEMPTS; i++) statuses.push((await hook(body)).status);
    expect(statuses).toEqual([...Array(HANDLER_MAX_ATTEMPTS - 1).fill(500), 200]);

    const logs = await prisma.systemLog.findMany({ where: { component: 'telegram' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('ERROR');
    expect(logs[0].context).toMatchObject({ updateId: 30, attempts: HANDLER_MAX_ATTEMPTS });
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(fake.token);
    expect(dump).not.toContain(SECRET);
  });

  it('a Redis failure while counting attempts still answers 500', async () => {
    vi.spyOn(app.get(TelegramUpdateHandler), 'handle').mockRejectedValueOnce(dbUnreachable());
    vi.spyOn(app.get(RedisService), 'multi').mockImplementationOnce(() => {
      throw new Error('redis down');
    });
    const res = await hook({ update_id: 31, message: { chat: { id: 1, type: 'private' }, text: 'hi' } });
    expect(res.status).toBe(500);
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
    while (!(await cond())) {
      if (Date.now() >= end) throw new Error(`waitFor zaman aşımı (${ms} ms)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('does not advance the offset past a failing update; retries it until it succeeds', async () => {
    const code = await newCode();
    const handler = app.get(TelegramUpdateHandler);
    const real = handler.handle.bind(handler);
    let failuresLeft = 2;
    const spy = vi.spyOn(handler, 'handle').mockImplementation(async (u) => {
      if (u.update_id === 50 && failuresLeft-- > 0) throw dbUnreachable();
      return real(u);
    });
    const polling = app.get(TelegramPollingService);
    polling.handlerRetryBaseMs = 20;
    // 49 başarılı bir no-op: offset 50'ye ilerler; 50 iki kez başarısız olur.
    fake.queueUpdates([{ update_id: 49, message: { chat: { id: 1, type: 'private' }, text: 'merhaba' } }, startUpdate(777, code, 50)]);
    polling.start();
    try {
      await waitFor(async () => (await channelCount()) === 1);
      expect(spy.mock.calls.filter(([u]) => u.update_id === 50)).toHaveLength(3);
      await waitFor(() => offsets().includes(51));
      const os = offsets();
      const before = os.slice(0, os.indexOf(51));
      // İlk çağrı 0; 49 onaylanınca 50 ile istenir; 50'nin iki başarısız denemesi offset'i ilerletmez (50 yeniden istenir), ancak sonra 51.
      expect(before[0]).toBe(0);
      expect(before.filter((o) => o === 50).length).toBeGreaterThanOrEqual(2);
      expect(before.every((o) => o === 0 || o === 50)).toBe(true);
      expect(os.indexOf(50)).toBeGreaterThan(-1);
      expect(os.indexOf(50)).toBeLessThan(os.indexOf(51));
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
      expect(spy.mock.calls.filter(([u]) => u.update_id === 60)).toHaveLength(polling.maxHandlerAttempts);
      expect(polling.maxHandlerAttempts).toBe(5);
    } finally {
      await polling.stop();
    }
  });
});
