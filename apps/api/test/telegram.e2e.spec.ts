import type { NestExpressApplication } from '@nestjs/platform-express';
import { Encryptor, hashToken } from '@oto/server-common';
import { FakeTelegramApi } from '@oto/telegram';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { TelegramPollingService } from '../src/modules/telegram/telegram-polling.service';
import { createTestApp, newAgent, registerUser, resetState, seedListing, verifyEmail } from './helpers';

const SECRET = 's'.repeat(40);
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

const hook = (body: object, secret = SECRET) =>
  newAgent(app).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', secret).send(body);

const start = (chatId: number, code: string, updateId = 1) =>
  hook({ update_id: updateId, message: { chat: { id: chatId }, text: `/start ${code}` } });

async function verifiedUser() {
  const u = await registerUser(app);
  await verifyEmail(app, u.user.id);
  return u;
}

async function newCode(u: Awaited<ReturnType<typeof registerUser>>): Promise<string> {
  const res = await u.agent.post('/api/v1/me/channels/telegram/link');
  expect(res.status).toBe(201);
  return new URL(res.body.deepLink).searchParams.get('start') as string;
}

const lastMessage = () => fake.requests.filter((r) => r.method === 'sendMessage').at(-1)?.body;

describe('Telegram link flow', () => {
  it('verified user links via deep link code; bot confirms; panel gets SECURITY notification', async () => {
    const A = await verifiedUser();
    const res = await A.agent.post('/api/v1/me/channels/telegram/link');
    expect(res.status).toBe(201);
    expect(res.body.deepLink).toMatch(/^https:\/\/t\.me\/otofirsat_test_bot\?start=[A-Za-z0-9_-]{16,64}$/);
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    const code = new URL(res.body.deepLink).searchParams.get('start') as string;

    expect((await start(555, code)).status).toBe(200);

    const ch = await prisma.notificationChannel.findUniqueOrThrow({ where: { userId_type: { userId: A.user.id, type: 'TELEGRAM' } } });
    expect(ch.isVerified).toBe(true);
    expect(ch.isEnabled).toBe(true);
    expect(ch.config).not.toContain('555');
    expect(app.get(Encryptor).decryptJson<{ chatId: number }>(ch.config as string)).toEqual({ chatId: 555 });
    expect(ch.externalIdHash).toBe(hashToken('555'));

    const sent = fake.requests.filter((r) => r.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(555);
    expect(sent[0].body.text).toContain('✅');

    const notes = await A.agent.get('/api/v1/me/notifications');
    const sec = notes.body.items.find((n: { kind: string }) => n.kind === 'SECURITY');
    expect(sec.payload.type).toBe('TELEGRAM_LINKED');

    const list = await A.agent.get('/api/v1/me/channels');
    expect(list.body.items.find((i: { type: string }) => i.type === 'TELEGRAM')).toMatchObject({ linked: true, isEnabled: true });
    expect(JSON.stringify(list.body)).not.toContain('555');
    expect(JSON.stringify(list.body)).not.toContain(hashToken('555'));
  });

  it('rejects bad, expired, reused codes and unverified accounts with a bot reply', async () => {
    const A = await verifiedUser();
    const channelCount = () => prisma.notificationChannel.count({ where: { type: 'TELEGRAM' } });
    const expectRejected = () => {
      expect(lastMessage().text).toContain('geçersiz');
    };

    // reused
    const code = await newCode(A);
    await start(555, code, 1);
    expect(await channelCount()).toBe(1);
    await prisma.notificationChannel.deleteMany({});
    fake.reset();
    await start(556, code, 2);
    expectRejected();
    expect(await channelCount()).toBe(0);

    // random well-formed code
    fake.reset();
    await start(557, 'A'.repeat(22), 3);
    expectRejected();
    expect(await channelCount()).toBe(0);

    // expired
    const expired = await newCode(A);
    await prisma.telegramLinkToken.updateMany({ where: { codeHash: hashToken(expired) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    fake.reset();
    await start(558, expired, 4);
    expectRejected();
    expect(await channelCount()).toBe(0);

    // email became unverified after code creation
    const fresh = await newCode(A);
    await prisma.user.update({ where: { id: A.user.id }, data: { emailVerifiedAt: null } });
    fake.reset();
    await start(559, fresh, 5);
    expectRejected();
    expect(await channelCount()).toBe(0);

    // malformed start payload gets guidance, no channel
    fake.reset();
    await start(560, '!!', 6);
    expect(lastMessage().text).toContain('Telegram');
    expect(await channelCount()).toBe(0);
  });

  it('link precedence when configured: EMAIL_NOT_VERIFIED before plan LIMIT_REACHED', async () => {
    const U = await registerUser(app);
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.subscriptionPlan.update({ where: { id: free.id }, data: { limits: { ...(free.limits as object), channels: ['IN_APP'] } } });
    const r1 = await U.agent.post('/api/v1/me/channels/telegram/link');
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    await verifyEmail(app, U.user.id);
    const r2 = await U.agent.post('/api/v1/me/channels/telegram/link');
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('LIMIT_REACHED');
    expect(r2.body.error.details).toEqual({ channel: 'TELEGRAM' });
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('new link code invalidates the previous one', async () => {
    const A = await verifiedUser();
    const first = await newCode(A);
    const second = await newCode(A);
    await start(555, first, 1);
    expect(lastMessage().text).toContain('geçersiz');
    expect(await prisma.notificationChannel.count({ where: { type: 'TELEGRAM' } })).toBe(0);
    fake.reset();
    await start(555, second, 2);
    expect(lastMessage().text).toContain('✅');
    expect(await prisma.notificationChannel.count({ where: { type: 'TELEGRAM', isVerified: true } })).toBe(1);
  });

  it('link codes are per-user: B generating a code does not invalidate or hijack A', async () => {
    const A = await verifiedUser();
    const B = await verifiedUser();
    const aCode = await newCode(A);
    const bCode = await newCode(B);
    expect(await prisma.telegramLinkToken.count({ where: { userId: A.user.id } })).toBe(1);
    expect(await prisma.telegramLinkToken.count({ where: { userId: B.user.id } })).toBe(1);
    await start(111, aCode, 1);
    await start(222, bCode, 2);
    const ch = async (id: string) =>
      app.get(Encryptor).decryptJson<{ chatId: number }>(
        (await prisma.notificationChannel.findUniqueOrThrow({ where: { userId_type: { userId: id, type: 'TELEGRAM' } } })).config as string,
      );
    expect(await ch(A.user.id)).toEqual({ chatId: 111 });
    expect(await ch(B.user.id)).toEqual({ chatId: 222 });
  });

  it('Favorile callback adds a favorite for the linked user and answers the callback', async () => {
    const A = await verifiedUser();
    await start(555, await newCode(A), 1);
    const { listingId } = await seedListing(app);
    fake.reset();

    const cb = (id: string, data: string, chat = 555, update = 9) =>
      hook({ update_id: update, callback_query: { id, data, message: { chat: { id: chat } } } });
    const answers = () => fake.requests.filter((r) => r.method === 'answerCallbackQuery').map((r) => r.body.text as string);

    expect((await cb('cb1', `fav:${listingId}`)).status).toBe(200);
    expect(await prisma.favorite.count({ where: { userId: A.user.id, listingId } })).toBe(1);
    expect(answers()).toEqual(['Favorilere eklendi ⭐']);

    await cb('cb2', `fav:${listingId}`, 555, 10);
    expect(await prisma.favorite.count({ where: { userId: A.user.id, listingId } })).toBe(1);

    await cb('cb3', 'fav:999999', 555, 11);
    expect(answers().at(-1)).toBe('İlan bulunamadı');

    await cb('cb4', `fav:${listingId}`, 777, 12);
    expect(answers().at(-1)).toBe('Hesap bağlı değil');
    await cb('cb5', 'nope', 555, 13);
    expect(answers().at(-1)).toBe('Geçersiz işlem');
    expect(await prisma.favorite.count()).toBe(1);
  });

  it('my_chat_member kicked disables the channel', async () => {
    const A = await verifiedUser();
    await start(555, await newCode(A), 1);
    expect(
      (await hook({ update_id: 2, my_chat_member: { chat: { id: 555 }, new_chat_member: { status: 'kicked' } } })).status,
    ).toBe(200);
    const ch = await prisma.notificationChannel.findUniqueOrThrow({ where: { userId_type: { userId: A.user.id, type: 'TELEGRAM' } } });
    expect(ch.isEnabled).toBe(false);
    expect(ch.isVerified).toBe(true);
  });

  it('webhook rejects a wrong or missing secret with 401 and does nothing', async () => {
    const A = await verifiedUser();
    const code = await newCode(A);
    const body = { update_id: 1, message: { chat: { id: 555 }, text: `/start ${code}` } };
    expect((await hook(body, 'x'.repeat(40))).status).toBe(401);
    expect((await hook(body, 'short')).status).toBe(401);
    expect((await newAgent(app).post('/api/v1/telegram/webhook').send(body)).status).toBe(401);
    expect(await prisma.notificationChannel.count({ where: { type: 'TELEGRAM' } })).toBe(0);
    expect(fake.requests).toHaveLength(0);
    // positive control
    expect((await hook(body)).status).toBe(200);
    expect(await prisma.notificationChannel.count({ where: { type: 'TELEGRAM' } })).toBe(1);
  });

  it('webhook answers 200 {ok:true} even for junk bodies and handler failures', async () => {
    const junk = await hook({ hello: 'world' });
    expect(junk.status).toBe(200);
    expect(junk.body).toEqual({ ok: true });
    // callback with an out-of-range listing id must not surface as an error
    const res = await hook({ update_id: 3, callback_query: { id: 'x', data: 'fav:99999999999', message: { chat: { id: 1 } } } });
    expect(res.status).toBe(200);
  });
});

describe('Telegram polling loop', () => {
  it('processes a queued update when started manually and stops on destroy', async () => {
    const A = await verifiedUser();
    const code = await newCode(A);
    fake.queueUpdates([{ update_id: 41, message: { chat: { id: 888 }, text: `/start ${code}` } }]);

    const polling = app.get(TelegramPollingService);
    polling.start();
    const end = Date.now() + 5000;
    while (Date.now() < end && (await prisma.notificationChannel.count({ where: { type: 'TELEGRAM' } })) === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await prisma.notificationChannel.count({ where: { type: 'TELEGRAM', isVerified: true } })).toBe(1);
    // the next getUpdates call carries the advanced offset
    const end2 = Date.now() + 5000;
    while (Date.now() < end2 && !fake.requests.some((r) => r.method === 'getUpdates' && r.body.offset === 42)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fake.requests.some((r) => r.method === 'getUpdates' && r.body.offset === 42)).toBe(true);

    await Promise.race([polling.onModuleDestroy(), new Promise((_, rej) => setTimeout(() => rej(new Error('stop hung')), 5000))]);
    await new Promise((r) => setTimeout(r, 200)); // in-flight aborted request may still be recorded
    const before = fake.requests.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.requests.length).toBe(before);
  });

  it('backs off on 409 Conflict instead of crashing or spinning', async () => {
    const polling = app.get(TelegramPollingService);
    polling.conflictWaitMs = 200;
    fake.respondNext('getUpdates', { status: 409, body: { ok: false, error_code: 409, description: 'Conflict: webhook is active' } });
    polling.start();
    await new Promise((r) => setTimeout(r, 120));
    const polls = () => fake.requests.filter((r) => r.method === 'getUpdates').length;
    expect(polls()).toBe(1); // still backing off
    const end = Date.now() + 3000;
    while (Date.now() < end && polls() < 2) await new Promise((r) => setTimeout(r, 50));
    expect(polls()).toBeGreaterThanOrEqual(2); // resumed
    await polling.stop();
    polling.conflictWaitMs = 30_000;
  });
});
