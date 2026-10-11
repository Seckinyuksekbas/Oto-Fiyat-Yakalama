import type { TestingModule } from '@nestjs/testing';
import { ADMIN_EVENTS_CHANNEL, adminEventSchema, notifyJobId, parseSettingValue, userEventChannel } from '@oto/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedError, FetchError } from '@oto/collection';
import { SourceHealthService } from '../src/collection/source-health.service';
import { AlertService, PERSISTENT_ALERT_TTL_SEC } from '../src/common/alert.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { NotificationDispatcher } from '../src/notifications/notification-dispatcher';
import { TELEGRAM_UNAUTHORIZED_FLAG } from '../src/notifications/notify.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { ALERT_THRESHOLDS_KEY, MonitorService } from '../src/scheduler/monitor.service';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';
import { AnalysisSweepService } from '../src/scheduler/analysis-sweep.service';
import { NotificationSweepService } from '../src/scheduler/notification-sweep.service';
import { RetentionService } from '../src/scheduler/retention.service';
import { SchedulerLoop } from '../src/scheduler/scheduler-loop.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { SubscriptionSweepService } from '../src/scheduler/subscription-sweep.service';
import { createAdmin, createChannel, createContext, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let redis: RedisService;
let monitor: MonitorService;

beforeAll(async () => {
  ref = await createContext([SchedulerModule]);
  prisma = ref.get(PrismaService);
  redis = ref.get(RedisService);
  monitor = ref.get(MonitorService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
});

const alertNotes = () => prisma.notification.findMany({ where: { kind: 'SYSTEM_ALERT', channel: 'IN_APP' } });
const keysOf = (rows: { payload: unknown }[]) => rows.map((r) => (r.payload as { key: string }).key).sort();

async function setThresholds(value: Record<string, unknown>) {
  const parsed = parseSettingValue(ALERT_THRESHOLDS_KEY, value);
  if (!parsed.ok) throw new Error('fixture invalid');
  await prisma.systemSetting.upsert({
    where: { key: ALERT_THRESHOLDS_KEY },
    create: { key: ALERT_THRESHOLDS_KEY, value: parsed.value as object },
    update: { value: parsed.value as object },
  });
  await redis.publish('settings:changed', ALERT_THRESHOLDS_KEY);
}

describe('MonitorService conditions', () => {
  it('source DOWN / blocked-PAUSED (active sources only) alert once, re-notify after 6 h; no log spam on repeat ticks', async () => {
    await createAdmin(ref);
    const down = await createSource(ref, 'http://demo.invalid', { health: 'DOWN' });
    const paused = await createSource(ref, 'http://demo.invalid', { health: 'PAUSED' });
    // Yönetici duraklatması yalnız isActive=false yazar (health olduğu gibi kalır): DOWN olsa da alarm yok.
    await createSource(ref, 'http://demo.invalid', { health: 'DOWN', isActive: false });
    // Plan 07 öncesi biçim (isActive=false + PAUSED) ve duraklatılmış engelli kaynak: etkin değil, alarm yok.
    await createSource(ref, 'http://demo.invalid', { health: 'PAUSED', isActive: false });
    await createSource(ref, 'http://demo.invalid', { health: 'HEALTHY' });

    const raised = await monitor.check(new Date());
    expect(raised.sort()).toEqual([`source:${down.id}:down`, `source:${paused.id}:blocked`].sort());
    expect(keysOf(await alertNotes())).toEqual([`source:${down.id}:down`, `source:${paused.id}:blocked`].sort());
    expect(await prisma.systemLog.count()).toBe(2);
    // Kalıcı durum: yeniden bildirim 6 saatte bir (varsayılan 30 dk değil)
    for (const key of [`alert:source:${down.id}:down`, `alert:source:${paused.id}:blocked`]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(30 * 60);
      expect(ttl).toBeLessThanOrEqual(PERSISTENT_ALERT_TTL_SEC);
    }

    await monitor.check(new Date());
    await monitor.check(new Date());
    expect(await alertNotes()).toHaveLength(2); // susturma
    expect(await prisma.systemLog.count()).toBe(2); // koşul sürdükçe her tick'te log yazılmaz
  });

  it('one block, one alarm: SourceHealth blocked alert and the monitor share the dedupe key', async () => {
    await createAdmin(ref);
    const src = await createSource(ref, 'http://demo.invalid', { health: 'PAUSED' });
    // SourceHealthService engelde bu anahtarla alarm verir
    await ref.get(AlertService).raise({ key: `source:${src.id}:blocked`, level: 'ERROR', component: 'collection', message: 'engellendi' });
    await monitor.check(new Date());
    expect(await alertNotes()).toHaveLength(1);
  });

  describe('one problem, one alarm across SourceHealthService and the monitor', () => {
    const health = () => new SourceHealthService(prisma, ref.get(AlertService));
    /** Susturma anahtarının kalan ömrünü `sec` kadar kısaltır (zamanın ilerlemesini taklit eder). */
    async function advance(key: string, sec: number) {
      const ttl = await redis.ttl(key);
      if (ttl - sec <= 0) await redis.del(key);
      else await redis.expire(key, ttl - sec);
    }

    it('a block followed by a monitor tick 31 minutes later produces exactly one alert', async () => {
      await createAdmin(ref);
      const src = await createSource(ref, 'http://demo.invalid');
      await health().recordFailure(src.id, new BlockedError('engellendi', null));
      expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: src.id } })).health).toBe('PAUSED');
      expect(await redis.ttl(`alert:source:${src.id}:blocked`)).toBeGreaterThan(30 * 60);
      await advance(`alert:source:${src.id}:blocked`, 31 * 60);
      await monitor.check(new Date());
      expect(keysOf(await alertNotes())).toEqual([`source:${src.id}:blocked`]);
    });

    it('DOWN from SourceHealthService is persistent (6 h) so the monitor does not re-fire 31 minutes later', async () => {
      await createAdmin(ref);
      const src = await createSource(ref, 'http://demo.invalid', { consecutiveFailures: 5, health: 'DEGRADED' });
      await health().recordFailure(src.id, new FetchError('NETWORK', 'bağlantı reddedildi', null, true));
      expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: src.id } })).health).toBe('DOWN');
      const ttl = await redis.ttl(`alert:source:${src.id}:down`);
      expect(ttl).toBeGreaterThan(30 * 60);
      expect(ttl).toBeLessThanOrEqual(PERSISTENT_ALERT_TTL_SEC);
      await advance(`alert:source:${src.id}:down`, 31 * 60);
      await monitor.check(new Date());
      expect(keysOf(await alertNotes())).toEqual([`source:${src.id}:down`]);
    });

    it('a layout break and the monitor parse-rate condition share one parse key', async () => {
      await createAdmin(ref);
      const src = await createSource(ref, 'http://demo.invalid');
      await health().recordLayoutBreak(src.id, new Error('liste bulunamadı'));
      const j = await prisma.collectionJob.create({ data: { sourceId: src.id, trigger: 'SCHEDULED', status: 'PARTIAL', pagesFetched: 20, finishedAt: new Date() } });
      await prisma.scrapeError.createMany({ data: Array.from({ length: 10 }, () => ({ sourceId: src.id, jobId: j.id, kind: 'PARSE' as const, message: 'x', transient: false })) });
      expect(await monitor.check(new Date())).toEqual([`source:${src.id}:parse`]);
      expect(await alertNotes()).toHaveLength(1);
    });

    it('recordFailure waits for a concurrent admin activate and does not overwrite it with stale PAUSED', async () => {
      const src = await createSource(ref, 'http://demo.invalid', { health: 'PAUSED', consecutiveFailures: 2 });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let lockedResolve!: () => void;
      const locked = new Promise<void>((r) => (lockedResolve = r));
      // Admin "activate": satırı kilitler, HEALTHY yapar, kısa süre sonra commit eder.
      const admin = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DataSource" WHERE id = ${src.id} FOR NO KEY UPDATE`;
        lockedResolve();
        await gate;
        await tx.dataSource.update({ where: { id: src.id }, data: { isActive: true, health: 'HEALTHY', consecutiveFailures: 0 } });
      });
      await locked;
      const failure = health().recordFailure(src.id, new FetchError('NETWORK', 'geçici', null, true));
      await new Promise((r) => setTimeout(r, 300));
      release();
      await admin;
      await failure;
      const after = await prisma.dataSource.findUniqueOrThrow({ where: { id: src.id } });
      expect(after.health).toBe('HEALTHY');
      expect(after.consecutiveFailures).toBe(1);
    });

    it('recordSuccess does not resurrect a stale health over a concurrent admin pause', async () => {
      const src = await createSource(ref, 'http://demo.invalid', { health: 'HEALTHY' });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let lockedResolve!: () => void;
      const locked = new Promise<void>((r) => (lockedResolve = r));
      const admin = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DataSource" WHERE id = ${src.id} FOR NO KEY UPDATE`;
        lockedResolve();
        await gate;
        await tx.dataSource.update({ where: { id: src.id }, data: { isActive: false, health: 'PAUSED' } });
      });
      await locked;
      const success = health().recordSuccess(src.id, 0);
      await new Promise((r) => setTimeout(r, 300));
      release();
      await admin;
      await success;
      expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: src.id } })).health).toBe('PAUSED');
    });
  });

  describe('parser error rate (PARSE errors / pages over the same finished jobs of the last hour)', () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const job = async (sourceId: number, over: Record<string, unknown> = {}) =>
      prisma.collectionJob.create({ data: { sourceId, trigger: 'SCHEDULED', status: 'PARTIAL', pagesFetched: 20, createdAt: ago(60_000), finishedAt: now, ...over } });
    const errs = (sourceId: number, jobId: number, n: number, kind: 'PARSE' | 'NETWORK' = 'PARSE') =>
      prisma.scrapeError.createMany({ data: Array.from({ length: n }, () => ({ sourceId, jobId, kind, message: 'x', transient: false, createdAt: now })) });

    it('alarms above the threshold only; NETWORK, old jobs, dry-runs and small samples do not count', async () => {
      await createAdmin(ref);
      const bad = await createSource(ref, 'http://demo.invalid');
      const ok = await createSource(ref, 'http://demo.invalid');
      const stale = await createSource(ref, 'http://demo.invalid');
      const small = await createSource(ref, 'http://demo.invalid');
      await errs(bad.id, (await job(bad.id)).id, 5); // 5/20 = 0.25 > 0.2
      await job(bad.id, { dryRun: true, pagesFetched: 1000 }); // dry-run sayfaları paydaya girmez
      const okJob = await job(ok.id);
      await errs(ok.id, okJob.id, 4); // 0.2, eşik aşılmadı
      await errs(ok.id, okJob.id, 6, 'NETWORK'); // PARSE değil
      await errs(stale.id, (await job(stale.id, { createdAt: ago(3 * 3600_000), finishedAt: ago(2 * 3600_000) })).id, 15); // pencere dışında
      await errs(small.id, (await job(small.id, { pagesFetched: 10 })).id, 9); // örnek < 20 sayfa
      expect(await monitor.check(now)).toEqual([`source:${bad.id}:parse`]);
    });

    it('a running job (errors written before closeJob) does not alarm', async () => {
      await createAdmin(ref);
      const s = await createSource(ref, 'http://demo.invalid');
      await job(s.id, { pagesFetched: 40 }); // biten, hatasız
      const running = await job(s.id, { status: 'RUNNING', pagesFetched: 0, finishedAt: null });
      await errs(s.id, running.id, 30);
      expect(await monitor.check(now)).toEqual([]);
    });

    it('a job queued more than 1 h ago that finished recently counts', async () => {
      await createAdmin(ref);
      const s = await createSource(ref, 'http://demo.invalid');
      const j = await job(s.id, { createdAt: ago(3 * 3600_000), startedAt: ago(10 * 60_000), finishedAt: ago(60_000) });
      await errs(s.id, j.id, 6);
      expect(await monitor.check(now)).toEqual([`source:${s.id}:parse`]);
    });
  });

  it('notify failure rate over the last hour (USER_INACTIVE and old rows excluded)', async () => {
    await createAdmin(ref);
    const u = await createUser(ref);
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 3600_000);
    const rows = (status: 'SENT' | 'FAILED', n: number, createdAt: Date, lastError: string | null = null) =>
      prisma.notification.createMany({
        data: Array.from({ length: n }, () => ({ userId: u.id, channel: 'TELEGRAM' as const, status, lastError, payload: {}, createdAt, sentAt: status === 'SENT' ? createdAt : null })),
      });
    await rows('SENT', 18, now);
    await rows('FAILED', 2, now); // 2/20 = 0.10 — eşik aşılmadı
    await rows('FAILED', 6, now, 'USER_INACTIVE'); // askıya alma, teslim hatası değil
    await rows('FAILED', 30, old);
    expect(await monitor.check(now)).toEqual([]);

    // IN_APP SYSTEM_ALERT (doğrudan SENT) oranı seyreltmez
    await prisma.notification.createMany({
      data: Array.from({ length: 100 }, () => ({ userId: u.id, kind: 'SYSTEM_ALERT' as const, channel: 'IN_APP' as const, status: 'SENT' as const, payload: {}, createdAt: now, sentAt: now })),
    });
    await rows('FAILED', 1, now); // 3/21 > 0.10
    expect(await monitor.check(now)).toEqual(['notify:failure-rate']);
  });

  it('worker heartbeat loss: seen record without live heartbeat older than heartbeatMissSec', async () => {
    await createAdmin(ref);
    const now = new Date();
    const seen = (host: string, pid: number, ageSec: number) =>
      redis.set(`worker:seen:${host}:${pid}`, JSON.stringify({ role: 'worker', host, pid, startedAt: now.toISOString(), at: new Date(now.getTime() - ageSec * 1000).toISOString() }), 'EX', 3600);
    await seen('hostA', 11, 120); // kayıp
    await seen('hostB', 12, 120);
    await redis.set('worker:heartbeat:hostB:12', '{}', 'EX', 45); // hâlâ canlı
    await seen('hostC', 13, 10); // eşik altında
    expect(await monitor.check(now)).toEqual(['worker:hostA:11:lost']);
    // Ölü worker'ın seen kaydı 24 saat durur: susturma bitse de aynı kayıp yeniden bildirilmez
    await redis.del('alert:worker:hostA:11:lost');
    expect(await monitor.check(now)).toEqual([]);
    expect(await alertNotes()).toHaveLength(1);
  });

  it('telegram 401 flag raises telegram:unauthorized', async () => {
    await createAdmin(ref);
    await redis.set(TELEGRAM_UNAUTHORIZED_FLAG, new Date().toISOString(), 'EX', 3600);
    expect(await monitor.check(new Date())).toEqual(['telegram:unauthorized']);
    const [n] = await alertNotes();
    expect(n.payload).toMatchObject({ key: 'telegram:unauthorized', level: 'ERROR' });
  });

  it('alerts.thresholds is consumed and a changed threshold takes effect on the next tick', async () => {
    await createAdmin(ref);
    const q = ref.get(QueueRegistry);
    await q.notify.addBulk([1, 2, 3].map((i) => ({ name: 'notify', data: { notificationId: 900_000 + i }, opts: { jobId: `t-${i}` } })));
    await q.notifyTelegram.add('notify', { notificationId: 900_010 }, { jobId: 't-10', delay: 60_000 });
    expect(await monitor.check(new Date())).toEqual([]); // varsayılan eşik 500

    await setThresholds({ notifyQueueDepth: 3 });
    expect(await monitor.check(new Date())).toEqual(['queue:notify:depth']); // 4 bekleyen > 3

    // Eşik geri yükseltilince (ve susturma bittiğinde) aynı koşul alarm üretmez
    await redis.del('alert:queue:notify:depth');
    await setThresholds({ notifyQueueDepth: 10 });
    expect(await monitor.check(new Date())).toEqual([]);

    // Geçersiz kayıtlı değer varsayılanlara düşer (alarm motoru durmaz)
    await prisma.systemSetting.update({ where: { key: ALERT_THRESHOLDS_KEY }, data: { value: { notifyQueueDepth: 'x' } } });
    expect(await monitor.check(new Date())).toEqual([]);
  });

  it('heartbeatMissSec threshold change applies on the next tick', async () => {
    await createAdmin(ref);
    const now = new Date();
    await redis.set('worker:seen:hostD:21', JSON.stringify({ role: 'worker', host: 'hostD', pid: 21, at: new Date(now.getTime() - 40_000).toISOString() }), 'EX', 3600);
    expect(await monitor.check(now)).toEqual([]); // 40 sn < 60 sn
    await setThresholds({ heartbeatMissSec: 30 });
    expect(await monitor.check(now)).toEqual(['worker:hostD:21:lost']);
  });

  it('a failing condition check does not stop the others', async () => {
    await createAdmin(ref);
    const down = await createSource(ref, 'http://demo.invalid', { health: 'DOWN' });
    const q = ref.get(QueueRegistry);
    const orig = q.notify.getJobCounts.bind(q.notify);
    q.notify.getJobCounts = () => Promise.reject(new Error('redis down'));
    try {
      expect(await monitor.check(new Date())).toEqual([`source:${down.id}:down`]);
    } finally {
      q.notify.getJobCounts = orig;
    }
  });
});

describe('AlertService delivery (Plan 07)', () => {
  it('with zero admins a monitor alarm is logged once, not every tick, and is delivered once an admin exists', async () => {
    const a = ref.get(AlertService);
    const alert = { key: 'test:noadmin', level: 'WARN' as const, component: 'test', message: 'x', dedupeLog: true };
    expect(await a.raise(alert)).toBe(false);
    expect(await a.raise(alert)).toBe(false);
    expect(await a.raise(alert)).toBe(false);
    expect(await prisma.systemLog.count()).toBe(1);
    await createAdmin(ref);
    expect(await a.raise(alert)).toBe(true);
    expect(await alertNotes()).toHaveLength(1);
    expect(await prisma.systemLog.count()).toBe(1);
  });

  it('clamps over-long keys/messages so the published admin event is schema-valid', async () => {
    await createAdmin(ref);
    const sub = redis.duplicate();
    const got: string[] = [];
    sub.on('message', (_ch: string, msg: string) => got.push(msg));
    await sub.subscribe(ADMIN_EVENTS_CHANNEL);
    try {
      await ref.get(AlertService).raise({ key: 'k'.repeat(500), level: 'ERROR', component: 'test', message: 'm'.repeat(5000) });
      const deadline = Date.now() + 2000;
      while (got.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const ev = adminEventSchema.parse(JSON.parse(got[0]));
      expect(ev.type === 'alert' ? [ev.key.length, ev.message.length] : null).toEqual([200, 4000]);
    } finally {
      await sub.quit();
    }
  });

  it('creates Telegram rows only for ACTIVE admins with a verified+enabled channel and queues them on notify-telegram', async () => {
    const a1 = await createAdmin(ref);
    await createChannel(ref, a1.id);
    const a2 = await createAdmin(ref);
    await createChannel(ref, a2.id, { isEnabled: false });
    const a3 = await createAdmin(ref);
    await createChannel(ref, a3.id, { isVerified: false });
    const a4 = await createAdmin(ref, 'SUSPENDED');
    await createChannel(ref, a4.id);
    const a5 = await createUser(ref, { role: 'SUPER_ADMIN' });
    await createChannel(ref, a5.id);
    const u = await createUser(ref);
    await createChannel(ref, u.id);
    const del = await createUser(ref, { role: 'ADMIN', status: 'DELETED' });
    await createChannel(ref, del.id);

    const delivered = await ref.get(AlertService).raise({ key: 'test:tg', level: 'ERROR', component: 'test', message: 'Kaynak <x> DOWN' });
    expect(delivered).toBe(true);

    const tg = await prisma.notification.findMany({ where: { channel: 'TELEGRAM' }, orderBy: { id: 'asc' } });
    expect(tg.map((n) => n.userId).sort()).toEqual([a1.id, a5.id].sort());
    for (const n of tg) {
      expect(n).toMatchObject({ kind: 'SYSTEM_ALERT', status: 'PENDING' });
      expect(n.queuedAt).not.toBeNull();
      expect(n.payload).toMatchObject({ type: 'SYSTEM_ALERT', key: 'test:tg', level: 'ERROR', message: 'Kaynak <x> DOWN' });
      expect(typeof (n.payload as { at: string }).at).toBe('string');
      expect(await ref.get(QueueRegistry).notifyTelegram.getJob(notifyJobId(n.id))).toBeDefined();
    }
    const inApp = await alertNotes();
    expect(inApp.map((n) => n.userId).sort()).toEqual([a1.id, a2.id, a3.id, a5.id].sort());
  });

  it('publishes to admin:events and each admin user:<id> channel', async () => {
    const admin = await createAdmin(ref);
    const sub = redis.duplicate();
    const got: Array<[string, string]> = [];
    sub.on('message', (ch: string, msg: string) => got.push([ch, msg]));
    await sub.subscribe(ADMIN_EVENTS_CHANNEL, userEventChannel(admin.id));
    try {
      await ref.get(AlertService).raise({ key: 'test:pub', level: 'WARN', component: 'test', message: 'hello' });
      const deadline = Date.now() + 2000;
      while (got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const adminMsg = got.find(([ch]) => ch === ADMIN_EVENTS_CHANNEL);
      const ev = adminEventSchema.parse(JSON.parse(adminMsg![1]));
      expect(ev).toMatchObject({ type: 'alert', key: 'test:pub', level: 'WARN', message: 'hello' });
      const userMsg = got.find(([ch]) => ch === userEventChannel(admin.id));
      expect(JSON.parse(userMsg![1])).toMatchObject({ type: 'notification', notification: { kind: 'SYSTEM_ALERT', channel: 'IN_APP' } });
    } finally {
      await sub.quit();
    }
  });

  it('dedupe is atomic: concurrent raises (two scheduler instances) deliver exactly once', async () => {
    const admin = await createAdmin(ref);
    await createChannel(ref, admin.id);
    const a = ref.get(AlertService);
    const b = new AlertService(prisma, redis, ref.get(NotificationDispatcher));
    const alert = { key: 'test:race', level: 'ERROR' as const, component: 'test', message: 'x', dedupeLog: true };
    const results = await Promise.all([a.raise(alert), b.raise(alert), a.raise(alert), b.raise(alert)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.notification.count({ where: { channel: 'IN_APP' } })).toBe(1);
    expect(await prisma.notification.count({ where: { channel: 'TELEGRAM' } })).toBe(1);
    expect(await prisma.systemLog.count()).toBe(1);
  });
});

describe('SchedulerLoop monitor throttle (Plan 07 test borcu)', () => {
  it('does not run the monitor twice within MONITOR_INTERVAL_MS, and runs it again once the interval passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
      const check = vi.spyOn(monitor, 'check');
      const env: Env = { ...ref.get<Env>(ENV), MONITOR_INTERVAL_MS: 60_000 };
      const leader = { isLeader: () => true, start: async () => undefined, onAcquired: () => undefined };
      const loop = new SchedulerLoop(
        ref.get(SchedulerService),
        ref.get(AnalysisSweepService),
        ref.get(NotificationSweepService),
        ref.get(SubscriptionSweepService),
        monitor,
        ref.get(RetentionService),
        leader as never,
        env,
      );
      await loop.safeTick();
      expect(check).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-11T10:00:59Z'));
      await loop.safeTick();
      expect(check).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-11T10:01:00Z'));
      await loop.safeTick();
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
