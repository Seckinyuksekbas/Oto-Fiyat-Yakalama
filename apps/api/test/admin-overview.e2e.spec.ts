import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ADMIN_EVENTS_CHANNEL, startOfIstanbulDay } from '@oto/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AdminQueues } from '../src/infra/admin-queues.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { SSE_RECHECK_MS } from '../src/infra/stream-session.service';
import { AdminEventsService } from '../src/modules/admin/admin-events.service';
import { AdminOverviewService } from '../src/modules/admin/overview.service';
import { AdminQueuesService } from '../src/modules/admin/queues.service';
import { AdminWorkersService } from '../src/modules/admin/workers.service';
import { loginCookie, registerUser, resetState, seedListing, setRole } from './helpers';
import { openSse, type SseClient } from './sse';

let app: NestExpressApplication;
let prisma: PrismaService;
const api = '/api/v1/admin';
const open: SseClient[] = [];
/** Oturum yeniden kontrolü + KPI tick'i testte 200 ms. */
const RECHECK_MS = 200;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SSE_RECHECK_MS).useValue(RECHECK_MS).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
  for (const q of ['scrape', 'analyze', 'match', 'notify', 'notify-telegram'] as const) await app.get(AdminQueues).get(q).obliterate({ force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) s.close();
});

async function actor(role: 'USER' | 'ADMIN' | 'SUPER_ADMIN') {
  const a = await registerUser(app);
  if (role !== 'USER') await setRole(app, a.user.id, role);
  return a;
}

const until = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const within = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

describe('GET /admin/overview', () => {
  it('USER -> 403', async () => {
    const u = await actor('USER');
    expect((await u.agent.get(`${api}/overview`)).status).toBe(403);
  });

  it('KPI counts on the Istanbul day boundary, queue depths, sources, workers and latency p50/p95 (fixed now)', async () => {
    // Sabit an: İstanbul'da 11.10.2026 12:00; gün başı 10.10.2026 21:00Z. Tüm zaman damgaları açıkça verilir.
    const now = new Date('2026-10-11T09:00:00.000Z');
    const dayStart = startOfIstanbulDay(now);
    expect(dayStart.toISOString()).toBe('2026-10-10T21:00:00.000Z');
    const yesterday = new Date(dayStart.getTime() - 1000);
    const admin = await actor('ADMIN');
    const setUser = (id: string, data: Record<string, unknown>) => prisma.user.update({ where: { id }, data });
    await setUser(admin.user.id, { createdAt: new Date(now.getTime() - 60_000) }); // bugün

    // users: admin (bugün), u1 (dün, ACTIVE), u2 (tam gün başında, SUSPENDED), u3 DELETED (sayılmaz)
    const u1 = await registerUser(app);
    await setUser(u1.user.id, { createdAt: yesterday });
    const u2 = await registerUser(app);
    await setUser(u2.user.id, { createdAt: dayStart, status: 'SUSPENDED' });
    const u3 = await registerUser(app);
    await setUser(u3.user.id, { createdAt: now, status: 'DELETED' });

    const profile = (status: 'ACTIVE' | 'PAUSED') =>
      prisma.searchProfile.create({ data: { userId: admin.user.id, name: 'P', status, channels: ['IN_APP'], fuels: [], transmissions: [], cities: [], minDiscountPct: 0 } });
    await profile('ACTIVE');
    await profile('ACTIVE');
    await profile('PAUSED');

    // listings: bugün yeni fırsat, dün görülen fırsat, bugün yeni düşük skor, bugün kaldırılan, dün kaldırılan
    await seedListing(app, { listing: { firstSeenAt: dayStart } });
    await seedListing(app, { listing: { firstSeenAt: yesterday } });
    await seedListing(app, { listing: { firstSeenAt: now }, analysis: { opportunityScore: 50 } });
    await seedListing(app, { listing: { firstSeenAt: yesterday, status: 'REMOVED', removedAt: now } });
    await seedListing(app, { listing: { firstSeenAt: yesterday, status: 'REMOVED', removedAt: yesterday } });

    const n = (status: 'SENT' | 'FAILED' | 'SKIPPED_LIMIT', at: Date, latencyMs: number | null = null, kind: 'MATCH' | 'SYSTEM_ALERT' = 'MATCH') =>
      prisma.notification.create({
        data: { userId: admin.user.id, kind, channel: 'TELEGRAM', status, payload: {}, createdAt: at, sentAt: status === 'SENT' ? at : null, latencyMs },
      });
    await n('SENT', now, 100);
    await n('SENT', now, 200);
    await n('SENT', dayStart, 300);
    await n('SENT', yesterday, 400);
    await n('SENT', yesterday, 1000);
    await n('SENT', new Date(now.getTime() - 25 * 3600_000), 50_000); // 24 saat dışında
    await n('SENT', now, 5, 'SYSTEM_ALERT'); // kullanıcı bildirimi değil
    await n('FAILED', now);
    await n('FAILED', yesterday);
    await n('SKIPPED_LIMIT', now);
    await n('SKIPPED_LIMIT', dayStart);

    const q = app.get(AdminQueues);
    await q.notify.add('notify', { notificationId: 1 }, { jobId: 'o-1' });
    await q.notify.add('notify', { notificationId: 2 }, { jobId: 'o-2' });
    await q.notify.add('notify', { notificationId: 3 }, { jobId: 'o-3', delay: 60_000 });
    await q.scrape.add('scrape', { collectionJobId: 1, sourceId: 1 }, { jobId: 'o-4' });

    const redis = app.get(RedisService);
    const beat = (host: string, pid: number) => JSON.stringify({ host, pid, role: 'worker', startedAt: now.toISOString(), at: now.toISOString() });
    await redis.set('worker:heartbeat:h1:1', beat('h1', 1), 'EX', 45);
    await redis.set('worker:seen:h1:1', beat('h1', 1), 'EX', 3600);
    await redis.set('worker:seen:h2:2', beat('h2', 2), 'EX', 3600);

    const src = await prisma.dataSource.findUniqueOrThrow({ where: { code: 'test-src' } });
    const view = JSON.parse(JSON.stringify(await app.get(AdminOverviewService).overview(now)));
    expect(view).toEqual({
      users: { total: 3, active: 2, suspended: 1, newToday: 2 },
      profiles: { active: 2 },
      listings: { active: 3, newToday: 2, removedToday: 1 },
      opportunities: { count: 2 },
      notifications: { sentToday: 3, failedToday: 1, skippedLimitToday: 2 },
      queues: { scrape: 1, analyze: 0, match: 0, notify: 3, 'notify-telegram': 0 },
      sources: [{ id: src.id, code: 'test-src', health: 'HEALTHY', isActive: false, lastSuccessAt: null }],
      workers: { alive: 1, dead: 1 },
      latency: { p50: 300, p95: 880 },
    });

    // HTTP uç noktası aynı şekli döner (gerçek saatle)
    const res = await admin.agent.get(`${api}/overview`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(view).sort());
  });

  it('latency is null without data', async () => {
    const admin = await actor('ADMIN');
    const res = await admin.agent.get(`${api}/overview`);
    expect(res.body.latency).toEqual({ p50: null, p95: null });
    expect(res.body.workers).toEqual({ alive: 0, dead: 0 });
  });

  it('Redis unavailable: queues and workers are null, the rest still answers', async () => {
    const admin = await actor('ADMIN');
    vi.spyOn(app.get(AdminQueuesService), 'list').mockRejectedValue(new Error('redis down'));
    vi.spyOn(app.get(AdminWorkersService), 'list').mockRejectedValue(new Error('redis down'));
    const res = await admin.agent.get(`${api}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.queues).toBeNull();
    expect(res.body.workers).toBeNull();
    expect(res.body.users.total).toBe(1);
  });

  it('KPI computation is cached and shared', async () => {
    const svc = app.get(AdminOverviewService);
    const spy = vi.spyOn(svc, 'kpi');
    const [a, b] = await Promise.all([svc.cachedKpi(), svc.cachedKpi()]);
    await svc.cachedKpi();
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('GET /admin/stream (SSE)', () => {
  it('USER -> 403', async () => {
    const u = await actor('USER');
    const res = await u.agent.get(`${api}/stream`);
    expect(res.status).toBe(403);
  });

  it('ADMIN gets ready (overview), alert/job events and periodic kpi; the listener is released on disconnect', async () => {
    const a = await actor('ADMIN');
    const events = app.get(AdminEventsService);
    const base = events.listenerCount();
    const sse = await openSse(app, await loginCookie(app, a.email, a.password), `${api}/stream`);
    open.push(sse);
    expect(sse.status).toBe(200);
    const ready = await sse.waitFor((e) => e.event === 'ready');
    expect(ready.data.users).toMatchObject({ total: 1, active: 1 });
    expect(ready.data.queues).toBeDefined();
    await until(() => events.listenerCount() === base + 1);

    const redis = app.get(RedisService);
    const at = new Date().toISOString();
    await redis.publish(ADMIN_EVENTS_CHANNEL, 'not json'); // yok sayılır
    await redis.publish(ADMIN_EVENTS_CHANNEL, JSON.stringify({ type: 'alert', key: 'source:1:down', level: 'ERROR', message: 'Demo DOWN', at }));
    await redis.publish(ADMIN_EVENTS_CHANNEL, JSON.stringify({ type: 'job', jobId: 7, sourceId: 1, status: 'RUNNING', at }));
    expect((await sse.waitFor((e) => e.event === 'alert')).data).toEqual({ type: 'alert', key: 'source:1:down', level: 'ERROR', message: 'Demo DOWN', at });
    expect((await sse.waitFor((e) => e.event === 'job')).data).toEqual({ type: 'job', jobId: 7, sourceId: 1, status: 'RUNNING', at });
    const kpi = await sse.waitFor((e) => e.event === 'kpi');
    expect(Object.keys(kpi.data).sort()).toEqual(['notifications', 'queues', 'sources', 'workers']);

    sse.close();
    await until(() => events.listenerCount() === base);
  });

  it.each([
    ['suspended', (userId: string) => prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } })],
    ['demoted to USER', (userId: string) => prisma.user.update({ where: { id: userId }, data: { role: 'USER' } })],
    ['session revoked', (userId: string) => prisma.session.updateMany({ where: { userId }, data: { revokedAt: new Date() } })],
  ])('the admin stream ends on the next tick when the admin is %s', async (_label, mutate) => {
    const a = await actor('ADMIN');
    const events = app.get(AdminEventsService);
    const sse = await openSse(app, await loginCookie(app, a.email, a.password), `${api}/stream`);
    open.push(sse);
    await sse.waitFor((e) => e.event === 'ready');
    await mutate(a.user.id);
    await within(sse.ended);
    await until(() => events.listenerCount() === 0);
  });

  it('many connections share one Redis subscriber (no per-connection connection leak)', async () => {
    const a = await actor('ADMIN');
    const cookie = await loginCookie(app, a.email, a.password);
    const events = app.get(AdminEventsService);
    const redis = app.get(RedisService);
    const clients = async () => ((await redis.client('LIST')) as string).split('\n').filter(Boolean).length;
    const first = await openSse(app, cookie, `${api}/stream`);
    open.push(first);
    await first.waitFor((e) => e.event === 'ready');
    const before = await clients();
    const more: SseClient[] = [];
    for (let i = 0; i < 5; i += 1) {
      const s = await openSse(app, cookie, `${api}/stream`);
      open.push(s);
      more.push(s);
      await s.waitFor((e) => e.event === 'ready');
    }
    expect(await clients()).toBe(before);
    expect(events.listenerCount()).toBe(6);
    for (const s of more) s.close();
    first.close();
    await until(() => events.listenerCount() === 0);
  });
});

describe('GET /me/notifications/stream session re-check', () => {
  it('ends the user stream once the session is revoked', async () => {
    const u = await actor('USER');
    const sse = await openSse(app, await loginCookie(app, u.email, u.password));
    open.push(sse);
    await sse.waitFor((e) => e.event === 'ready');
    await prisma.session.updateMany({ where: { userId: u.user.id }, data: { revokedAt: new Date() } });
    await within(sse.ended);
  });

  it('keeps a valid user stream open across re-checks', async () => {
    const u = await actor('USER');
    const sse = await openSse(app, await loginCookie(app, u.email, u.password));
    open.push(sse);
    await sse.waitFor((e) => e.event === 'ready');
    const ended = await Promise.race([sse.ended.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), RECHECK_MS * 4))]);
    expect(ended).toBe(false);
  });
});
