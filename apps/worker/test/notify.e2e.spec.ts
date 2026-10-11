import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { userEventSchema } from '@oto/shared';
import { FakeTelegramApi } from '@oto/telegram';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotifyService } from '../src/notifications/notify.service';
import { NOTIFY_WORKER_AUTOSTART, NotifyWorkerHost } from '../src/processors/notify-worker.host';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAnalysis, createChannel, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

@Module({
  imports: [NotificationsModule, MatchingModule],
  providers: [NotifyWorkerHost, { provide: NOTIFY_WORKER_AUTOSTART, useValue: false }],
  exports: [NotifyWorkerHost],
})
class NotifyTestModule {}

const fake = new FakeTelegramApi();
let ref: TestingModule;
let prisma: PrismaService;
let notify: NotifyService;
let sourceId: number;
const FIRST = { attemptsMade: 0, maxAttempts: 5 };

beforeAll(async () => {
  const { apiBase, token } = await fake.start();
  // ENV, modül oluşturulurken ayrıştırılır; createContext'ten ÖNCE ayarlanmalı.
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_API_BASE = apiBase;
  process.env.PUBLIC_BASE_URL = 'https://otofirsat.example';
  ref = await createContext([NotifyTestModule]);
  prisma = ref.get(PrismaService);
  notify = ref.get(NotifyService);
});
afterAll(async () => {
  await ref.get(NotifyWorkerHost).onModuleDestroy();
  await ref.close();
  await fake.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ref.get(NotifyWorkerHost).onModuleDestroy();
});
beforeEach(async () => {
  await resetState(ref);
  fake.reset();
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timed out');
}

async function clearChatGate() {
  const redis = ref.get(RedisService);
  const keys = await redis.keys('tg:chat:*');
  if (keys.length) await redis.del(...keys);
}

async function makeMatch(userId: string, listingOver: Record<string, unknown> = {}) {
  const l = await createListing(ref, sourceId, { price: 960_000n, ...listingOver });
  const a = await createAnalysis(ref, l.id);
  await ref.get(MatchService).process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
  return l;
}

async function setup(channels = ['IN_APP', 'TELEGRAM'], chatId = 4242) {
  const u = await createUser(ref);
  const ch = await createChannel(ref, u.id, { chatId });
  await createProfile(ref, u.id, { channels });
  return { u, ch, chatId };
}

const rowFor = (userId: string, channel: string) => prisma.notification.findMany({ where: { userId, channel: channel as 'IN_APP' | 'TELEGRAM', kind: 'MATCH' }, orderBy: { id: 'asc' } });

describe('NotifyService', () => {
  it('IN_APP: publishes a UserEvent on user:<id> and marks SENT with latencyMs', async () => {
    const { u } = await setup();
    const sub = ref.get(RedisService).duplicate();
    const received: string[] = [];
    sub.on('message', (_c, m) => received.push(m));
    await sub.subscribe(`user:${u.id}`);
    const l = await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'IN_APP');
    expect(await notify.process(n.id, FIRST)).toEqual({ kind: 'DONE', status: 'SENT' });
    await waitFor(async () => received.length > 0);
    await sub.quit();
    const ev = userEventSchema.parse(JSON.parse(received[0]));
    expect(ev).toMatchObject({ type: 'notification', notification: { id: n.id } });
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(1);
    const expected = row.sentAt!.getTime() - l.firstSeenAt.getTime();
    expect(Math.abs(row.latencyMs! - expected)).toBeLessThan(1000);
  });

  it('TELEGRAM: sends the rendered message with buttons to the decrypted chatId', async () => {
    const { u, chatId } = await setup();
    const l = await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    expect(await notify.process(n.id, FIRST)).toEqual({ kind: 'DONE', status: 'SENT' });
    const req = fake.requests.at(-1)!;
    expect(req.method).toBe('sendMessage');
    expect(req.body.chat_id).toBe(chatId);
    expect(req.body.text).toContain('Fırsat');
    expect(JSON.stringify(req.body.reply_markup)).toContain(`fav:${l.id}`);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT');
  });

  it('TELEGRAM: photo with bad URL falls back to sendMessage once', async () => {
    const { u } = await setup();
    await makeMatch(u.id, { imageUrl: 'https://img.example/x.jpg' });
    const [n] = await rowFor(u.id, 'TELEGRAM');
    fake.respondNext('sendPhoto', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' } });
    expect(await notify.process(n.id, FIRST)).toEqual({ kind: 'DONE', status: 'SENT' });
    expect(fake.requests.map((r) => r.method)).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('TELEGRAM 429: returns RETRY with retryAfterMs, increments attempts; last attempt marks FAILED', async () => {
    const { u } = await setup();
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    fake.respondNext('sendMessage', { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } });
    expect(await notify.process(n.id, FIRST)).toMatchObject({ kind: 'RETRY', retryAfterMs: 7000 });
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row.lastError).toContain('429');

    await clearChatGate();
    fake.respondNext('sendMessage', { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } });
    expect(await notify.process(n.id, { attemptsMade: 4, maxAttempts: 5 })).toEqual({ kind: 'DONE', status: 'FAILED' });
    const failed = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toContain('502');
    expect(failed.attempts).toBe(2);
  });

  it('TELEGRAM 403 blocked: FAILED, channel disabled, SECURITY in-app warning published; other pending TELEGRAM fail as CHANNEL_UNAVAILABLE', async () => {
    const { u } = await setup();
    await makeMatch(u.id);
    await makeMatch(u.id);
    const [first, second] = await rowFor(u.id, 'TELEGRAM');
    const sub = ref.get(RedisService).duplicate();
    const received: string[] = [];
    sub.on('message', (_c, m) => received.push(m));
    await sub.subscribe(`user:${u.id}`);
    fake.respondNext('sendMessage', { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
    expect(await notify.process(first.id, FIRST)).toEqual({ kind: 'DONE', status: 'FAILED' });
    expect((await prisma.notificationChannel.findUniqueOrThrow({ where: { userId_type: { userId: u.id, type: 'TELEGRAM' } } })).isEnabled).toBe(false);
    const warn = await prisma.notification.findFirstOrThrow({ where: { userId: u.id, kind: 'SECURITY' } });
    expect(warn).toMatchObject({ channel: 'IN_APP', status: 'SENT', payload: { type: 'TELEGRAM_DISABLED' } });
    await waitFor(async () => received.length > 0);
    await sub.quit();
    expect(userEventSchema.parse(JSON.parse(received[0]))).toMatchObject({ notification: { id: warn.id } });

    const before = fake.requests.length;
    expect(await notify.process(second.id, FIRST)).toEqual({ kind: 'DONE', status: 'FAILED' });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: second.id } })).lastError).toBe('CHANNEL_UNAVAILABLE');
    expect(fake.requests.length).toBe(before);
  });

  it('per-chat throttle returns THROTTLED without consuming an attempt', async () => {
    const { u } = await setup();
    await makeMatch(u.id);
    await makeMatch(u.id);
    const [a, b] = await rowFor(u.id, 'TELEGRAM');
    expect(await notify.process(a.id, FIRST)).toEqual({ kind: 'DONE', status: 'SENT' });
    const r = await notify.process(b.id, FIRST);
    expect(r.kind).toBe('THROTTLED');
    expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('re-checks plan channels at send time', async () => {
    const { u } = await setup();
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.userSubscription.create({ data: { userId: u.id, planId: free.id, limitOverrides: { channels: ['IN_APP'] } } });
    expect(await notify.process(n.id, FIRST)).toEqual({ kind: 'DONE', status: 'FAILED' });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).lastError).toBe('CHANNEL_UNAVAILABLE');
    expect(fake.requests).toHaveLength(0);
  });

  it('is idempotent: non-PENDING notifications are skipped', async () => {
    const { u } = await setup();
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    await prisma.notification.update({ where: { id: n.id }, data: { status: 'SENT' } });
    expect(await notify.process(n.id, FIRST)).toEqual({ kind: 'DONE', status: 'SKIPPED' });
    expect(fake.requests).toHaveLength(0);
  });

  it('host end-to-end: queued TELEGRAM job is sent by the worker', async () => {
    const { u } = await setup();
    ref.get(NotifyWorkerHost).start();
    await makeMatch(u.id);
    await waitFor(async () => fake.requests.some((r) => r.method === 'sendMessage'));
    const [n] = await rowFor(u.id, 'TELEGRAM');
    const row = await waitFor(async () => {
      const r = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
      return r.status === 'SENT' ? r : null;
    });
    expect(row.sentAt).not.toBeNull();
    const [inApp] = await rowFor(u.id, 'IN_APP');
    await waitFor(async () => (await prisma.notification.findUniqueOrThrow({ where: { id: inApp.id } })).status === 'SENT');
  });

  it('host: a retryable failure schedules a delayed retry via the custom backoff', async () => {
    const { u } = await setup(['TELEGRAM']);
    ref.get(NotifyWorkerHost).start();
    fake.respondNext('sendMessage', { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } });
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    const job = await waitFor(async () => {
      const j = await ref.get(QueueRegistry).notifyTelegram.getJob(`notify-${n.id}`);
      return j && (await j.getState()) === 'delayed' ? j : null;
    });
    expect(job.attemptsMade).toBe(1);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row.lastError).toContain('502');
    const delayUntil = job.timestamp + (job.delay ?? 0);
    expect(delayUntil).toBeGreaterThan(Date.now());
    expect(job.delay).toBeGreaterThanOrEqual(9_000);
    expect(job.delay).toBeLessThanOrEqual(11_000);
  });

  it('host: two notifications for the same chat are throttled, both SENT, throttled job keeps attemptsMade 0', async () => {
    const { u } = await setup(['TELEGRAM']);
    ref.get(NotifyWorkerHost).start();
    await makeMatch(u.id);
    await makeMatch(u.id);
    await waitFor(async () => (await prisma.notification.count({ where: { userId: u.id, channel: 'TELEGRAM', status: 'SENT' } })) === 2, 30_000);
    const sends = fake.requests.filter((r) => r.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    const rows = await rowFor(u.id, 'TELEGRAM');
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    const sentTimes = rows.map((r) => r.sentAt!.getTime()).sort();
    expect(sentTimes[1] - sentTimes[0]).toBeGreaterThanOrEqual(900);
  });

  it('host failed listener: exhausted (or stalled) jobs mark a still-PENDING row FAILED, others are left alone', async () => {
    const { u } = await setup(['TELEGRAM']);
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    const host = ref.get(NotifyWorkerHost);
    const job = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 5 }, data: { notificationId: n.id } }) as never;
    await host.failIfExhausted(job(2), new Error('boom'));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('PENDING');
    await host.failIfExhausted(job(5), new Error('x'.repeat(900)));
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError!.length).toBeLessThanOrEqual(500);

    const [inApp] = await rowFor(u.id, 'IN_APP');
    await host.failIfExhausted(job(1), new Error('job stalled more than allowable limit'));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: inApp.id } })).status).toBe('PENDING'); // yanlış satır etkilenmez
    await host.failIfExhausted({ attemptsMade: 1, opts: { attempts: 5 }, data: { notificationId: inApp.id } } as never, new Error('job stalled more than allowable limit'));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: inApp.id } })).status).toBe('FAILED');
  });

  it('corrupt channel config fails permanently without retries', async () => {
    const { u, ch } = await setup(['TELEGRAM']);
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    await prisma.notificationChannel.update({ where: { id: ch.id }, data: { config: 'v1:garbage:garbage:garbage' } });
    expect(await notify.process(n.id, FIRST)).toEqual({ kind: 'DONE', status: 'FAILED' });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).lastError).toBe('CHANNEL_CONFIG_INVALID');
    expect(fake.requests).toHaveLength(0);
  });

  it('host safety net: unexpected error on the last attempt marks the row FAILED', async () => {
    const { u } = await setup(['TELEGRAM']);
    await makeMatch(u.id);
    const [n] = await rowFor(u.id, 'TELEGRAM');
    const queue = ref.get(QueueRegistry).notifyTelegram;
    await queue.obliterate({ force: true });
    vi.spyOn(notify, 'process').mockRejectedValue(new Error('boom bot123:SECRET-tok'));
    ref.get(NotifyWorkerHost).start();
    await queue.add('notify', { notificationId: n.id }, { jobId: `notify-${n.id}`, attempts: 1, backoff: { type: 'custom' } });
    const row = await waitFor(async () => {
      const r = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
      return r.status === 'FAILED' ? r : null;
    });
    expect(row.lastError).toContain('boom');
    expect(row.lastError).not.toContain('SECRET');
    expect(row.attempts).toBe(1);
  });
});
