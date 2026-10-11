import type { NestExpressApplication } from '@nestjs/platform-express';
import { notifyJobId } from '@oto/shared';
import { Worker, type Queue } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminQueues, ADMIN_QUEUE_NAMES } from '../src/infra/admin-queues.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { createTestApp, registerUser, resetState, seedListing, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let redis: RedisService;
let queues: AdminQueues;
type Agent = Awaited<ReturnType<typeof registerUser>>['agent'];
let admin: Agent;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  redis = app.get(RedisService);
  queues = app.get(AdminQueues);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
  for (const n of ADMIN_QUEUE_NAMES) await queues.get(n).obliterate({ force: true });
  const a = await registerUser(app);
  await setRole(app, a.user.id, 'ADMIN');
  admin = a.agent;
});

const api = (p: string) => `/api/v1/admin${p}`;
const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { id: 'asc' } });

/** Gerçek BullMQ işleyicisiyle verilen işleri başarısız duruma getirir (deneme 1). */
async function failJobs(queue: Queue, jobs: Array<{ jobId?: string; data?: unknown }>): Promise<void> {
  for (const j of jobs) await queue.add('t', j.data ?? { x: 1 }, { jobId: j.jobId, attempts: 1 });
  const conn = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const worker = new Worker(queue.name, async () => {
    throw new Error('boom');
  }, { connection: conn });
  try {
    const deadline = Date.now() + 10_000;
    while ((await queue.getJobCounts('failed')).failed < jobs.length) {
      if (Date.now() > deadline) throw new Error('jobs did not fail in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await worker.close();
    await conn.quit();
  }
}

/** Başarısız işleri BullMQ'nun "bitiş" zamanına göre eskitir (clean testleri için). */
async function ageFailedJobs(queue: Queue, ageMs: number): Promise<void> {
  const old = Date.now() - ageMs;
  const failed = await queue.getJobs(['failed']);
  for (const j of failed) {
    await redis.hset(`bull:${queue.name}:${j.id}`, 'finishedOn', String(old));
    await redis.zadd(`bull:${queue.name}:failed`, old, j.id!);
  }
}

describe('GET /admin/queues', () => {
  it('returns every whitelisted queue with counts and pause state', async () => {
    await queues.scrape.add('t', { a: 1 });
    const res = await admin.get(api('/queues'));
    expect(res.status).toBe(200);
    expect(res.body.map((q: { name: string }) => q.name)).toEqual(['scrape', 'analyze', 'match', 'notify', 'notify-telegram']);
    const scrape = res.body.find((q: { name: string }) => q.name === 'scrape');
    expect(scrape).toEqual({
      name: 'scrape',
      isPaused: false,
      counts: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0, prioritized: 0, paused: 0 },
    });
  });
});

describe('POST /admin/queues/:name/retry-failed', () => {
  it('retries failed jobs, audits once, and a second click is a no-op', async () => {
    await failJobs(queues.match, [{}, {}, {}]);
    const res = await admin.post(api('/queues/match/retry-failed'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retried: 3 });
    const counts = await queues.match.getJobCounts('failed', 'waiting');
    expect(counts).toMatchObject({ failed: 0, waiting: 3 });

    const again = await admin.post(api('/queues/match/retry-failed'));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ retried: 0 });
    const rows = await audits('queue.retry-failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'Queue', targetId: 'match', after: { retried: 3 } });
  });

  it('concurrent clicks never retry the same job twice', async () => {
    await failJobs(queues.match, [{}, {}]);
    const [a, b] = await Promise.all([admin.post(api('/queues/match/retry-failed')), admin.post(api('/queues/match/retry-failed'))]);
    expect(a.body.retried + b.body.retried).toBe(2);
    expect((await queues.match.getJobCounts('waiting')).waiting).toBe(2);
  });

  it('rejects unknown queue names with 400', async () => {
    for (const name of ['nope', 'bull', 'notify:x', 'SCRAPE']) {
      const res = await admin.post(api(`/queues/${encodeURIComponent(name)}/retry-failed`));
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
    }
    expect(await audits('queue.retry-failed')).toHaveLength(0);
  });
});

describe('POST /admin/queues/:name/clean', () => {
  it('removes only jobs older than the threshold, audits only when something was removed', async () => {
    await failJobs(queues.analyze, [{}, {}]);
    const young = await admin.post(api('/queues/analyze/clean')).send({ state: 'failed', olderThanSec: 3600 });
    expect(young.status).toBe(200);
    expect(young.body).toEqual({ removed: 0 });
    expect(await audits('queue.clean')).toHaveLength(0);

    await ageFailedJobs(queues.analyze, 2 * 3600_000);
    const res = await admin.post(api('/queues/analyze/clean')).send({ state: 'failed', olderThanSec: 3600 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });
    expect((await queues.analyze.getJobCounts('failed')).failed).toBe(0);
    const rows = await audits('queue.clean');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetId: 'analyze', after: { state: 'failed', olderThanSec: 3600, removed: 2 } });
  });

  it('validates body (state whitelist, olderThanSec >= 3600, strict) and queue name', async () => {
    const bad = [
      { state: 'waiting', olderThanSec: 3600 },
      { state: 'active', olderThanSec: 3600 },
      { state: 'failed', olderThanSec: 60 },
      { state: 'failed', olderThanSec: 3600, limit: 5 },
      {},
    ];
    for (const body of bad) {
      const res = await admin.post(api('/queues/analyze/clean')).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const unknown = await admin.post(api('/queues/other/clean')).send({ state: 'failed', olderThanSec: 3600 });
    expect(unknown.status).toBe(400);
  });
});

describe('GET /admin/workers', () => {
  it('lists live workers from heartbeats and dead ones from last-seen records', async () => {
    const now = new Date().toISOString();
    const live = { role: 'worker', pid: 11, host: 'h1', startedAt: '2026-10-11T00:00:00.000Z', at: now };
    const dead = { role: 'scheduler', pid: 22, host: 'h2', startedAt: '2026-10-10T00:00:00.000Z', at: '2026-10-11T01:00:00.000Z' };
    await redis.set('worker:heartbeat:h1:11', JSON.stringify(live), 'EX', 45);
    await redis.set('worker:seen:h1:11', JSON.stringify(live), 'EX', 86400);
    await redis.set('worker:seen:h2:22', JSON.stringify(dead), 'EX', 86400);
    await redis.set('worker:seen:junk:1', 'not-json', 'EX', 86400);

    const res = await admin.get(api('/workers'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { host: 'h1', pid: 11, role: 'worker', startedAt: live.startedAt, lastSeenAt: now, alive: true },
      { host: 'h2', pid: 22, role: 'scheduler', startedAt: dead.startedAt, lastSeenAt: dead.at, alive: false },
    ]);
  });

  it('returns an empty list without heartbeats', async () => {
    const res = await admin.get(api('/workers'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

const matchPayload = (title: string, reason: 'NEW' | 'PRICE_DROP' | 'RELIST') => ({
  type: 'MATCH',
  reason,
  profile: { id: 'p', name: 'Profil' },
  listing: { id: 1, title, url: 'http://demo/1?secret=1' },
  chatId: '999',
});

async function seedNotif(userId: string, over: Record<string, unknown> = {}) {
  return prisma.notification.create({
    data: {
      userId,
      kind: 'MATCH',
      channel: 'IN_APP',
      status: 'FAILED',
      attempts: 5,
      lastError: 'telegram 500',
      payload: matchPayload('BMW 320i', 'NEW'),
      ...over,
    } as never,
  });
}

describe('GET /admin/notifications', () => {
  it('lists with user email, payload summary and lastError; filters; never leaks payload/config/chatId', async () => {
    const u = await registerUser(app, { email: 'alici@test.com' });
    const other = await registerUser(app);
    const a = await seedNotif(u.user.id, { channel: 'TELEGRAM', payload: matchPayload('Audi A4', 'PRICE_DROP') });
    await seedNotif(u.user.id, { status: 'SENT', lastError: null, sentAt: new Date() });
    await seedNotif(other.user.id, { kind: 'SECURITY', payload: { type: 'TELEGRAM_LINKED' } });

    const res = await admin.get(api('/notifications')).query({ status: 'FAILED', channel: 'TELEGRAM' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: a.id,
      userId: u.user.id,
      userEmail: 'alici@test.com',
      kind: 'MATCH',
      channel: 'TELEGRAM',
      status: 'FAILED',
      attempts: 5,
      lastError: 'telegram 500',
      title: 'Audi A4',
      reason: 'PRICE_DROP',
    });
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain('999');
    expect(dump).not.toContain('secret');
    expect(res.body.items[0]).not.toHaveProperty('payload');

    const byUser = await admin.get(api('/notifications')).query({ userId: u.user.id });
    expect(byUser.body.total).toBe(2);
    const byKind = await admin.get(api('/notifications')).query({ kind: 'SECURITY' });
    expect(byKind.body.total).toBe(1);
    expect(byKind.body.items[0]).toMatchObject({ title: 'TELEGRAM_LINKED', reason: null });
    const paged = await admin.get(api('/notifications')).query({ pageSize: 1, page: 2 });
    expect(paged.body).toMatchObject({ total: 3 });
    expect(paged.body.items).toHaveLength(1);
  });

  it('rejects invalid filters', async () => {
    for (const q of [{ kind: 'NOPE' }, { pageSize: 101 }, { status: 'X' }, { foo: 1 }]) {
      const res = await admin.get(api('/notifications')).query(q);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
  });
});

describe('POST /admin/notifications/retry', () => {
  it('re-enqueues only retryable FAILED rows (remove-then-add), skips the rest, audits once; repeat is a no-op', async () => {
    const u = await registerUser(app);
    const susp = await registerUser(app);
    await prisma.user.update({ where: { id: susp.user.id }, data: { status: 'SUSPENDED' } });

    const inApp = await seedNotif(u.user.id);
    const tg = await seedNotif(u.user.id, { channel: 'TELEGRAM', payload: matchPayload('x', 'RELIST') });
    const sent = await seedNotif(u.user.id, { status: 'SENT', lastError: null, sentAt: new Date(), payload: matchPayload('y', 'RELIST') });
    const inactive = await seedNotif(u.user.id, { lastError: 'USER_INACTIVE', payload: matchPayload('z', 'RELIST') });
    const suspended = await seedNotif(susp.user.id);
    const email = await seedNotif(u.user.id, { channel: 'EMAIL', kind: 'SECURITY', payload: { type: 'REFRESH_REUSED' } });

    // Eski başarısız iş (removeOnFail 7 gün): aynı jobId ile ekleme sessizce yok sayılırdı; servis önce kaldırmalı.
    await failJobs(queues.notify, [{ jobId: notifyJobId(inApp.id), data: { notificationId: inApp.id } }]);

    const ids = [inApp.id, tg.id, sent.id, inactive.id, suspended.id, email.id, 987654];
    const res = await admin.post(api('/notifications/retry')).send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.retried).toEqual([inApp.id, tg.id]);
    expect(res.body.skipped).toEqual([
      { id: sent.id, reason: 'NOT_FAILED' },
      { id: inactive.id, reason: 'USER_INACTIVE' },
      { id: suspended.id, reason: 'USER_INACTIVE' },
      { id: email.id, reason: 'UNSUPPORTED_CHANNEL' },
      { id: 987654, reason: 'NOT_FOUND' },
    ]);

    const jobA = await queues.notify.getJob(notifyJobId(inApp.id));
    expect(await jobA!.getState()).toBe('waiting');
    expect(jobA!.data).toEqual({ notificationId: inApp.id });
    expect(jobA!.opts.attempts).toBe(5);
    const jobB = await queues.notifyTelegram.getJob(notifyJobId(tg.id));
    expect(await jobB!.getState()).toBe('waiting');

    for (const id of [inApp.id, tg.id]) {
      const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
      expect(row.queuedAt).not.toBeNull();
    }
    const untouched = await prisma.notification.findUniqueOrThrow({ where: { id: inactive.id } });
    expect(untouched).toMatchObject({ status: 'FAILED', lastError: 'USER_INACTIVE' });

    const again = await admin.post(api('/notifications/retry')).send({ ids: [inApp.id, tg.id] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ retried: [], skipped: [{ id: inApp.id, reason: 'NOT_FAILED' }, { id: tg.id, reason: 'NOT_FAILED' }] });
    expect((await queues.notify.getJobCounts('waiting')).waiting).toBe(1);
    expect((await queues.notifyTelegram.getJobCounts('waiting')).waiting).toBe(1);

    const rows = await audits('notification.retry');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'Notification', after: { ids: [inApp.id, tg.id] } });
  });

  it('concurrent double click retries each row exactly once', async () => {
    const u = await registerUser(app);
    const n1 = await seedNotif(u.user.id);
    const n2 = await seedNotif(u.user.id, { payload: matchPayload('b', 'NEW') });
    const body = { ids: [n1.id, n2.id] };
    const [a, b] = await Promise.all([admin.post(api('/notifications/retry')).send(body), admin.post(api('/notifications/retry')).send(body)]);
    expect([...a.body.retried, ...b.body.retried].sort()).toEqual([n1.id, n2.id].sort());
    expect((await queues.notify.getJobCounts('waiting')).waiting).toBe(2);
    const auditCount = (await audits('notification.retry')).length;
    expect(auditCount).toBe(a.body.retried.length > 0 && b.body.retried.length > 0 ? 2 : 1);
  });

  it('validates ids (1..100, strict)', async () => {
    for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, { ids: [0] }, { ids: [1], x: 1 }]) {
      const res = await admin.post(api('/notifications/retry')).send(body);
      expect(res.status).toBe(400);
    }
  });
});

describe('GET /admin/notifications/latency', () => {
  it('computes p50/p95 per reason and channel from SENT rows in range', async () => {
    const u = await registerUser(app);
    const now = Date.now();
    for (const ms of [100, 200, 300, 400, 500]) {
      await seedNotif(u.user.id, { status: 'SENT', lastError: null, sentAt: new Date(now - 60_000), latencyMs: ms });
    }
    await seedNotif(u.user.id, { status: 'SENT', lastError: null, channel: 'TELEGRAM', sentAt: new Date(now - 60_000), latencyMs: 1000, payload: matchPayload('p', 'PRICE_DROP') });
    // aralık dışı (3 gün önce) ve FAILED satırlar 24 saatte sayılmaz
    await seedNotif(u.user.id, { status: 'SENT', lastError: null, sentAt: new Date(now - 3 * 86400_000), latencyMs: 9000 });
    await seedNotif(u.user.id, { latencyMs: 50 });

    const res = await admin.get(api('/notifications/latency'));
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('24h');
    expect(res.body.byReason).toEqual({
      NEW: { p50: 300, p95: 480, n: 5 },
      PRICE_DROP: { p50: 1000, p95: 1000, n: 1 },
      RELIST: { p50: null, p95: null, n: 0 },
    });
    expect(res.body.byChannel).toEqual({
      IN_APP: { p50: 300, p95: 480, n: 5 },
      TELEGRAM: { p50: 1000, p95: 1000, n: 1 },
      EMAIL: { p50: null, p95: null, n: 0 },
    });

    const week = await admin.get(api('/notifications/latency')).query({ range: '7d' });
    expect(week.body.byReason.NEW.n).toBe(6);

    const bad = await admin.get(api('/notifications/latency')).query({ range: '1y' });
    expect(bad.status).toBe(400);
  });
});

describe('match dispatches', () => {
  async function seedDispatch(attempts: number, queued = false) {
    const { analysisId, listingId } = await seedListing(app);
    await prisma.listingAnalysis.update({
      where: { id: analysisId },
      data: { matchEvent: 'NEW', matchDispatchAttempts: attempts, matchQueuedAt: queued ? new Date() : null },
    });
    return { analysisId, listingId };
  }

  it('GET /admin/match-dispatches/stuck lists capped, unqueued analyses with listing summary', async () => {
    const stuck = await seedDispatch(10);
    await seedDispatch(3);
    await seedDispatch(10, true);
    const res = await admin.get(api('/match-dispatches/stuck'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      analysisId: stuck.analysisId,
      listingId: stuck.listingId,
      matchEvent: 'NEW',
      matchDispatchAttempts: 10,
      listing: { title: expect.any(String), make: 'BMW', status: 'ACTIVE' },
    });
    expect((await admin.get(api('/match-dispatches/stuck')).query({ pageSize: 101 })).status).toBe(400);
  });

  it('POST reset zeroes the counter, clears the alarm flag, audits once; repeat and non-stuck are no-ops', async () => {
    const stuck = await seedDispatch(12);
    await redis.set(`match-dispatch-stuck:alerted:${stuck.analysisId}`, '1');
    const res = await admin.post(api(`/match-dispatches/${stuck.analysisId}/reset`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ analysisId: stuck.analysisId, matchDispatchAttempts: 0 });
    const row = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: stuck.analysisId } });
    expect(row.matchDispatchAttempts).toBe(0);
    expect(await redis.exists(`match-dispatch-stuck:alerted:${stuck.analysisId}`)).toBe(0);

    const again = await admin.post(api(`/match-dispatches/${stuck.analysisId}/reset`));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ analysisId: stuck.analysisId, matchDispatchAttempts: 0 });

    const healthy = await seedDispatch(3);
    const h = await admin.post(api(`/match-dispatches/${healthy.analysisId}/reset`));
    expect(h.body).toEqual({ analysisId: healthy.analysisId, matchDispatchAttempts: 3 });

    const rows = await audits('match-dispatch.reset');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'ListingAnalysis', targetId: String(stuck.analysisId), before: { matchDispatchAttempts: 12 }, after: { matchDispatchAttempts: 0 } });

    expect((await admin.post(api('/match-dispatches/999999/reset'))).status).toBe(404);
    expect((await admin.post(api('/match-dispatches/abc/reset'))).status).toBe(400);
  });
});
