import type { NestExpressApplication } from '@nestjs/platform-express';
import { DEFAULT_ANALYSIS_SETTINGS, DEFAULT_ALERT_THRESHOLDS } from '@oto/shared';
import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { createTestApp, registerUser, resetState, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const api = '/api/v1/admin';

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function actor(role: 'ADMIN' | 'SUPER_ADMIN', email?: string) {
  const a = await registerUser(app, email ? { email } : {});
  await setRole(app, a.user.id, role);
  return a;
}

const plan = (code: string) => prisma.subscriptionPlan.findUniqueOrThrow({ where: { code } });
const auditCount = (action: string) => prisma.auditLog.count({ where: { action } });
const limits = (over: Record<string, unknown> = {}) => ({
  maxSearchProfiles: 5,
  maxNotificationsPerDay: 50,
  channels: ['IN_APP', 'TELEGRAM'],
  opportunitiesDelayHours: 0,
  ...over,
});

// ---------------------------------------------------------------- plans
describe('admin plans', () => {
  it('GET lists plans with active subscriber counts (ADMIN allowed)', async () => {
    const admin = await actor('ADMIN');
    const u = await registerUser(app); // kayıtta FREE abonelik
    await prisma.userSubscription.updateMany({ where: { userId: u.user.id }, data: { status: 'CANCELED' } });
    await prisma.userSubscription.create({ data: { userId: u.user.id, planId: (await plan('PRO')).id } });
    const res = await admin.agent.get(`${api}/plans`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const byCode = Object.fromEntries(res.body.items.map((p: { code: string }) => [p.code, p]));
    expect(byCode.PRO.activeSubscriptions).toBe(1);
    expect(byCode.FREE.activeSubscriptions).toBe(1); // admin'in kendi FREE aboneliği
    expect(byCode.FREE.limits.channels).toContain('IN_APP');
  });

  it('ADMIN cannot create or update plans (403)', async () => {
    const admin = await actor('ADMIN');
    const free = await plan('FREE');
    expect((await admin.agent.post(`${api}/plans`).send({ code: 'X1', name: 'X', priceMonthly: 0, isActive: true, limits: limits() })).status).toBe(403);
    expect((await admin.agent.patch(`${api}/plans/${free.id}`).send({ name: 'Y' })).status).toBe(403);
  });

  it('SUPER_ADMIN creates a plan with an atomic audit row; duplicate code -> 409', async () => {
    const sa = await actor('SUPER_ADMIN');
    const body = { code: 'GOLD', name: 'Altın', priceMonthly: 9900, isActive: true, limits: limits() };
    const res = await sa.agent.post(`${api}/plans`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.plan).toMatchObject({ code: 'GOLD', name: 'Altın', isActive: true, activeSubscriptions: 0 });
    expect(await auditCount('plan.create')).toBe(1);
    const dup = await sa.agent.post(`${api}/plans`).send(body);
    expect(dup.status).toBe(409);
    expect(await auditCount('plan.create')).toBe(1);
  });

  it('limits without IN_APP are rejected (create and update) and nothing is stored', async () => {
    const sa = await actor('SUPER_ADMIN');
    const c = await sa.agent.post(`${api}/plans`).send({ code: 'NOAPP', name: 'N', priceMonthly: 0, isActive: true, limits: limits({ channels: ['TELEGRAM'] }) });
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe('VALIDATION_FAILED');
    expect(await prisma.subscriptionPlan.count({ where: { code: 'NOAPP' } })).toBe(0);
    const pro = await plan('PRO');
    const u = await sa.agent.patch(`${api}/plans/${pro.id}`).send({ limits: limits({ channels: ['EMAIL'] }) });
    expect(u.status).toBe(400);
    expect((await plan('PRO')).limits).toEqual(pro.limits);
  });

  it('numeric limits and price have sane maxima; channels must be unique; price must be integer', async () => {
    const sa = await actor('SUPER_ADMIN');
    const pro = await plan('PRO');
    for (const bad of [
      { limits: limits({ maxSearchProfiles: 1_000_001 }) },
      { limits: limits({ maxNotificationsPerDay: 10_000_000 }) },
      { limits: limits({ opportunitiesDelayHours: 100_000 }) },
      { limits: limits({ channels: ['IN_APP', 'IN_APP'] }) },
      { priceMonthly: 1e12 },
      { priceMonthly: 10.5 },
      { limits: { maxSearchProfiles: 3 } }, // limits tam nesne olmalı
    ]) {
      const r = await sa.agent.patch(`${api}/plans/${pro.id}`).send(bad);
      expect({ bad, status: r.status }).toEqual({ bad, status: 400 });
    }
    expect(await auditCount('plan.update')).toBe(0);
  });

  it('FREE plan cannot be deactivated (409) nor its code changed (400)', async () => {
    const sa = await actor('SUPER_ADMIN');
    const free = await plan('FREE');
    const off = await sa.agent.patch(`${api}/plans/${free.id}`).send({ isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('INVALID_OPERATION');
    const code = await sa.agent.patch(`${api}/plans/${free.id}`).send({ code: 'BASIC' });
    expect(code.status).toBe(400);
    const after = await plan('FREE');
    expect(after).toMatchObject({ code: 'FREE', isActive: true });
    expect(await auditCount('plan.update')).toBe(0);
    // FREE limitleri değiştirilebilir (IN_APP korunarak)
    const ok = await sa.agent.patch(`${api}/plans/${free.id}`).send({ limits: limits({ maxSearchProfiles: 3, channels: ['IN_APP'] }) });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.limits.maxSearchProfiles).toBe(3);
  });

  it('update writes before/after audit; no-op update writes nothing; unknown id -> 404', async () => {
    const sa = await actor('SUPER_ADMIN');
    const pro = await plan('PRO');
    const r = await sa.agent.patch(`${api}/plans/${pro.id}`).send({ name: 'Pro+', priceMonthly: 4900 });
    expect(r.status).toBe(200);
    expect(r.body.plan).toMatchObject({ name: 'Pro+', priceMonthly: 4900 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'plan.update' } });
    expect(log).toMatchObject({ targetType: 'SubscriptionPlan', targetId: pro.id, actorId: sa.user.id });
    expect(log.before).toMatchObject({ name: 'Pro', priceMonthly: 0 });
    expect(log.after).toMatchObject({ name: 'Pro+', priceMonthly: 4900 });
    const same = await sa.agent.patch(`${api}/plans/${pro.id}`).send({ name: 'Pro+', limits: pro.limits });
    expect(same.status).toBe(200);
    expect(await auditCount('plan.update')).toBe(1);
    expect((await sa.agent.patch(`${api}/plans/nope`).send({ name: 'Z' })).status).toBe(404);
  });

  it('PATCH reports usersOverProfileLimit (FREE counts fallback users; unverified rule applies); profiles are not paused', async () => {
    const sa = await actor('SUPER_ADMIN');
    const free = await plan('FREE');
    const pro = await plan('PRO');
    const mkProfiles = async (userId: string, n: number) => {
      for (let i = 0; i < n; i++) await prisma.searchProfile.create({ data: { userId, name: `P${i}`, channels: ['IN_APP'], fuels: [], transmissions: [], cities: [], minDiscountPct: 0 } });
    };
    const verified = await registerUser(app);
    await prisma.user.update({ where: { id: verified.user.id }, data: { emailVerifiedAt: new Date() } });
    await mkProfiles(verified.user.id, 2);
    const unverified = await registerUser(app); // doğrulanmamış: en fazla 1 aktif profil
    await mkProfiles(unverified.user.id, 2);
    const fallback = await registerUser(app); // aboneliği yok → örtük FREE
    await prisma.user.update({ where: { id: fallback.user.id }, data: { emailVerifiedAt: new Date() } });
    await prisma.userSubscription.deleteMany({ where: { userId: fallback.user.id } });
    await mkProfiles(fallback.user.id, 3);
    const proUser = await registerUser(app);
    await prisma.userSubscription.updateMany({ where: { userId: proUser.user.id }, data: { status: 'CANCELED' } });
    await prisma.userSubscription.create({ data: { userId: proUser.user.id, planId: pro.id } });
    await prisma.user.update({ where: { id: proUser.user.id }, data: { emailVerifiedAt: new Date() } });
    await mkProfiles(proUser.user.id, 5);

    const r3 = await sa.agent.patch(`${api}/plans/${free.id}`).send({ limits: limits({ maxSearchProfiles: 3, channels: ['IN_APP'] }) });
    expect(r3.status).toBe(200);
    expect(r3.body.plan.usersOverProfileLimit).toBe(1); // yalnızca doğrulanmamış (2 > 1)
    const r1 = await sa.agent.patch(`${api}/plans/${free.id}`).send({ limits: limits({ maxSearchProfiles: 1, channels: ['IN_APP'] }) });
    expect(r1.body.plan.usersOverProfileLimit).toBe(3); // PRO kullanıcısı sayılmaz
    expect(await prisma.searchProfile.count({ where: { status: 'ACTIVE' } })).toBe(12);
    const rp = await sa.agent.patch(`${api}/plans/${pro.id}`).send({ limits: limits({ maxSearchProfiles: 4 }) });
    expect(rp.body.plan.usersOverProfileLimit).toBe(1);
  });

  it('deactivating a plan with active subscribers is allowed: existing subs keep it, new assignment -> 409', async () => {
    const sa = await actor('SUPER_ADMIN');
    const pro = await plan('PRO');
    const u = await registerUser(app);
    await prisma.userSubscription.updateMany({ where: { userId: u.user.id }, data: { status: 'CANCELED' } });
    const sub = await prisma.userSubscription.create({ data: { userId: u.user.id, planId: pro.id } });
    const off = await sa.agent.patch(`${api}/plans/${pro.id}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.plan).toMatchObject({ isActive: false, activeSubscriptions: 1 });
    expect((await prisma.userSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('ACTIVE');
    const other = await registerUser(app);
    const assign = await sa.agent.patch(`${api}/users/${other.user.id}/subscription`).send({ planId: pro.id, endsAt: null, limitOverrides: null });
    expect(assign.status).toBe(409);
  });
});

// ---------------------------------------------------------------- settings
describe('admin settings', () => {
  let sub: Redis;
  const messages: string[] = [];
  beforeAll(async () => {
    sub = app.get(RedisService).duplicate();
    sub.on('message', (ch: string, msg: string) => messages.push(`${ch}|${msg}`));
    await sub.subscribe('settings:changed');
  });
  afterAll(async () => {
    await sub.quit();
  });
  beforeEach(() => {
    messages.length = 0;
  });
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };
  const stored = async (key: string) => (await prisma.systemSetting.findUnique({ where: { key } }))?.value ?? null;

  it('GET returns both whitelisted keys with defaults, stored value and effective merge (ADMIN allowed)', async () => {
    const admin = await actor('ADMIN');
    await prisma.systemSetting.create({ data: { key: 'analysis.settings', value: { minComparables: 6 } } });
    const res = await admin.agent.get(`${api}/settings`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.items.map((s: { key: string }) => [s.key, s]));
    expect(Object.keys(byKey).sort()).toEqual(['alerts.thresholds', 'analysis.settings']);
    expect(byKey['analysis.settings']).toMatchObject({
      value: { minComparables: 6 },
      defaults: DEFAULT_ANALYSIS_SETTINGS,
      effective: { ...DEFAULT_ANALYSIS_SETTINGS, minComparables: 6 },
    });
    expect(byKey['analysis.settings'].updatedAt).toBeTruthy();
    expect(byKey['alerts.thresholds']).toMatchObject({ value: null, updatedAt: null, defaults: DEFAULT_ALERT_THRESHOLDS, effective: DEFAULT_ALERT_THRESHOLDS });
  });

  it('ADMIN cannot PATCH settings (403)', async () => {
    const admin = await actor('ADMIN');
    const r = await admin.agent.patch(`${api}/settings`).send({ key: 'analysis.settings', value: { minComparables: 6 } });
    expect(r.status).toBe(403);
    expect(await stored('analysis.settings')).toBeNull();
  });

  it('valid PATCH upserts, audits atomically and publishes settings:changed with the key', async () => {
    const sa = await actor('SUPER_ADMIN');
    const r = await sa.agent.patch(`${api}/settings`).send({ key: 'analysis.settings', value: { minComparables: 6, smallPoolMax: 9 } });
    expect(r.status).toBe(200);
    expect(r.body.setting).toMatchObject({ key: 'analysis.settings', value: { minComparables: 6, smallPoolMax: 9 } });
    expect(await stored('analysis.settings')).toEqual({ minComparables: 6, smallPoolMax: 9 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.update' } });
    expect(log).toMatchObject({ targetType: 'SystemSetting', targetId: 'analysis.settings', before: null, after: { minComparables: 6, smallPoolMax: 9 } });
    await waitFor(() => messages.length > 0);
    expect(messages).toEqual(['settings:changed|analysis.settings']);
  });

  it('PATCH merges into stored value (JSON merge patch; null resets a field to default)', async () => {
    const sa = await actor('SUPER_ADMIN');
    await prisma.systemSetting.create({ data: { key: 'analysis.settings', value: { minComparables: 6, yearAdjPct: 0.05 } } });
    const r = await sa.agent.patch(`${api}/settings`).send({ key: 'analysis.settings', value: { yearAdjPct: null, kmAdjPer10k: 0.03 } });
    expect(r.status).toBe(200);
    expect(await stored('analysis.settings')).toEqual({ minComparables: 6, kmAdjPer10k: 0.03 });
    expect(r.body.setting.effective).toEqual({ ...DEFAULT_ANALYSIS_SETTINGS, minComparables: 6, kmAdjPer10k: 0.03 });
  });

  it('cross-field conflict on the MERGED value -> 400, stored value untouched, no audit, no publish', async () => {
    const sa = await actor('SUPER_ADMIN');
    await prisma.systemSetting.create({ data: { key: 'analysis.settings', value: { minComparables: 10, smallPoolMax: 20, theilSenMinPool: 20 } } });
    // Yama tek başına varsayılanlarla geçerli (smallPoolMax 8 ≥ 5) ama kayıtlı minComparables=10 ile birleşince çelişir.
    const r = await sa.agent.patch(`${api}/settings`).send({ key: 'analysis.settings', value: { smallPoolMax: 8 } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(r.body.error.details)).toContain('smallPoolMax');
    expect(await stored('analysis.settings')).toEqual({ minComparables: 10, smallPoolMax: 20, theilSenMinPool: 20 });
    expect(await auditCount('settings.update')).toBe(0);
    await new Promise((res) => setTimeout(res, 150));
    expect(messages).toEqual([]);
  });

  it('a patch invalid against defaults alone but valid once merged with stored is accepted', async () => {
    const sa = await actor('SUPER_ADMIN');
    await prisma.systemSetting.create({ data: { key: 'analysis.settings', value: { smallPoolMax: 20, theilSenMinPool: 20 } } });
    const r = await sa.agent.patch(`${api}/settings`).send({ key: 'analysis.settings', value: { minComparables: 10 } });
    expect(r.status).toBe(200);
    expect(await stored('analysis.settings')).toEqual({ smallPoolMax: 20, theilSenMinPool: 20, minComparables: 10 });
  });

  it('unknown key, unknown field, wrong type, out-of-range and non-object values -> 400; stored kept', async () => {
    const sa = await actor('SUPER_ADMIN');
    await prisma.systemSetting.create({ data: { key: 'alerts.thresholds', value: { notifyQueueDepth: 700 } } });
    for (const body of [
      { key: 'nope.key', value: {} },
      { key: 'alerts.thresholds', value: { bogus: 1 } },
      { key: 'alerts.thresholds', value: { notifyFailureRate: 'x' } },
      { key: 'alerts.thresholds', value: { notifyFailureRate: 2 } },
      { key: 'alerts.thresholds', value: [1, 2] },
      { key: 'alerts.thresholds', value: 5 },
      { key: 'alerts.thresholds' },
      { key: 'alerts.thresholds', value: {}, extra: true },
    ]) {
      const r = await sa.agent.patch(`${api}/settings`).send(body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
    expect(await stored('alerts.thresholds')).toEqual({ notifyQueueDepth: 700 });
    expect(await auditCount('settings.update')).toBe(0);
  });

  it('prototype keys (__proto__, constructor) in the patch are rejected with 400 and never merged', async () => {
    const sa = await actor('SUPER_ADMIN');
    await prisma.systemSetting.create({ data: { key: 'alerts.thresholds', value: { notifyQueueDepth: 700 } } });
    for (const raw of ['{"key":"alerts.thresholds","value":{"__proto__":{"notifyQueueDepth":1}}}', '{"key":"alerts.thresholds","value":{"constructor":{"prototype":{"x":1}}}}']) {
      const r = await sa.agent.patch(`${api}/settings`).set('Content-Type', 'application/json').send(raw);
      expect({ raw, status: r.status, code: r.body.error?.code }).toEqual({ raw, status: 400, code: 'VALIDATION_FAILED' });
    }
    expect(await stored('alerts.thresholds')).toEqual({ notifyQueueDepth: 700 });
    expect(({} as Record<string, unknown>).notifyQueueDepth).toBeUndefined();
    expect(await auditCount('settings.update')).toBe(0);
  });

  it('an invalid stored value is not silently discarded: unrelated patch -> 400, fixing patch (null or valid value) succeeds', async () => {
    const sa = await actor('SUPER_ADMIN');
    const bad = { notifyFailureRate: 5, parserErrorRate: 'x', notifyQueueDepth: 700 };
    await prisma.systemSetting.create({ data: { key: 'alerts.thresholds', value: bad } });
    const unrelated = await sa.agent.patch(`${api}/settings`).send({ key: 'alerts.thresholds', value: { heartbeatMissSec: 90 } });
    expect(unrelated.status).toBe(400);
    const paths = JSON.stringify(unrelated.body.error.details);
    expect(paths).toContain('value.notifyFailureRate');
    expect(paths).toContain('value.parserErrorRate');
    expect(await stored('alerts.thresholds')).toEqual(bad);
    const fix = await sa.agent.patch(`${api}/settings`).send({ key: 'alerts.thresholds', value: { notifyFailureRate: null, parserErrorRate: 0.3 } });
    expect(fix.status).toBe(200);
    expect(await stored('alerts.thresholds')).toEqual({ notifyQueueDepth: 700, parserErrorRate: 0.3 });
    expect(fix.body.setting.effective).toEqual({ ...DEFAULT_ALERT_THRESHOLDS, notifyQueueDepth: 700, parserErrorRate: 0.3 });
  });

  it('no-op PATCH writes no audit and publishes nothing', async () => {
    const sa = await actor('SUPER_ADMIN');
    await prisma.systemSetting.create({ data: { key: 'alerts.thresholds', value: { notifyQueueDepth: 700 } } });
    const r = await sa.agent.patch(`${api}/settings`).send({ key: 'alerts.thresholds', value: { notifyQueueDepth: 700 } });
    expect(r.status).toBe(200);
    expect(await auditCount('settings.update')).toBe(0);
    await new Promise((res) => setTimeout(res, 150));
    expect(messages).toEqual([]);
  });

  it('concurrent PATCHes on different fields are serialised (no lost update)', async () => {
    const sa = await actor('SUPER_ADMIN');
    const fields = ['notifyQueueDepth', 'heartbeatMissSec', 'notifyFailureRate', 'parserErrorRate'] as const;
    const vals = { notifyQueueDepth: 900, heartbeatMissSec: 90, notifyFailureRate: 0.3, parserErrorRate: 0.4 };
    const rs = await Promise.all(fields.map((f) => sa.agent.patch(`${api}/settings`).send({ key: 'alerts.thresholds', value: { [f]: vals[f] } })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await stored('alerts.thresholds')).toEqual(vals);
    expect(await auditCount('settings.update')).toBe(4);
  });

  it('publish failure does not fail the request (value committed)', async () => {
    const sa = await actor('SUPER_ADMIN');
    vi.spyOn(app.get(RedisService), 'publish').mockRejectedValueOnce(new Error('redis down'));
    const r = await sa.agent.patch(`${api}/settings`).send({ key: 'alerts.thresholds', value: { heartbeatMissSec: 120 } });
    expect(r.status).toBe(200);
    expect(await stored('alerts.thresholds')).toEqual({ heartbeatMissSec: 120 });
    expect(await auditCount('settings.update')).toBe(1);
  });
});

// ---------------------------------------------------------------- logs
describe('admin audit and system logs', () => {
  it('audit-logs: newest first with actor email, filters and pagination', async () => {
    const admin = await actor('ADMIN', 'auditor@test.com');
    const other = await actor('SUPER_ADMIN', 'boss_1@test.com');
    const lookalike = await actor('ADMIN', 'bossX1@test.com');
    const t0 = new Date('2026-10-01T10:00:00Z');
    await prisma.auditLog.createMany({
      data: [
        { actorId: admin.user.id, action: 'user.suspend', targetType: 'User', targetId: 'u1', before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' }, createdAt: t0 },
        { actorId: other.user.id, action: 'plan.update', targetType: 'SubscriptionPlan', targetId: 'p1', createdAt: new Date(t0.getTime() + 60_000) },
        { actorId: other.user.id, action: 'settings.update', targetType: 'SystemSetting', targetId: 'analysis.settings', createdAt: new Date(t0.getTime() + 120_000) },
        { actorId: null, action: 'auth.login_failed', createdAt: new Date(t0.getTime() + 180_000) },
        { actorId: lookalike.user.id, action: 'proxy.check', targetType: 'ProxyConfig', targetId: '9', createdAt: new Date(t0.getTime() - 60_000) },
      ],
    });
    const all = await admin.agent.get(`${api}/audit-logs`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(5);
    expect(all.body.items.map((i: { action: string }) => i.action)).toEqual(['auth.login_failed', 'settings.update', 'plan.update', 'user.suspend', 'proxy.check']);
    expect(all.body.items[0].actor).toBeNull();
    expect(all.body.items[3]).toMatchObject({ actor: { id: admin.user.id, email: 'auditor@test.com' }, before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' } });
    expect(all.body.items[3].actor.passwordHash).toBeUndefined();

    const q = (query: Record<string, unknown>) => admin.agent.get(`${api}/audit-logs`).query(query);
    expect((await q({ actorId: other.user.id })).body.total).toBe(2);
    expect((await q({ actor: 'boss_1' })).body.total).toBe(2);
    expect((await q({ actor: 'boss%' })).body.total).toBe(0); // % kaçışlı
    // `_` kaçışlı: yalnızca boss_1 eşleşir; kaçışsız olsaydı bossX1 de (tek karakter joker) eşleşirdi.
    const us = await q({ actor: 'boss_' });
    expect(us.body.total).toBe(2);
    expect([...new Set(us.body.items.map((i: { actor: { email: string } }) => i.actor.email))]).toEqual(['boss_1@test.com']);
    expect((await q({ actor: 'bossX1' })).body.total).toBe(1);
    expect((await q({ action: 'plan.update' })).body.total).toBe(1);
    expect((await q({ targetType: 'User' })).body.total).toBe(1);
    expect((await q({ targetId: 'analysis.settings' })).body.total).toBe(1);
    expect((await q({ from: new Date(t0.getTime() + 60_000).toISOString(), to: new Date(t0.getTime() + 120_000).toISOString() })).body.total).toBe(2);
    const p2 = await q({ page: 2, pageSize: 3 });
    expect(p2.body).toMatchObject({ total: 5 });
    expect(p2.body.items.map((i: { action: string }) => i.action)).toEqual(['user.suspend', 'proxy.check']);
  });

  it('audit-logs: strict query validation', async () => {
    const admin = await actor('ADMIN');
    for (const query of [{ pageSize: 101 }, { page: 100001 }, { page: 0 }, { bogus: 1 }, { from: 'yesterday' }, { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }]) {
      const r = await admin.agent.get(`${api}/audit-logs`).query(query);
      expect({ query, status: r.status }).toEqual({ query, status: 400 });
    }
  });

  it('audit-logs: entries of a deleted (anonymised) actor show the anonymised email', async () => {
    const admin = await actor('ADMIN');
    const sa = await actor('SUPER_ADMIN');
    const victim = await actor('ADMIN', 'victim@test.com');
    await prisma.auditLog.create({ data: { actorId: victim.user.id, action: 'user.update', targetType: 'User', targetId: 'z' } });
    const del = await sa.agent.delete(`${api}/users/${victim.user.id}`);
    expect(del.status).toBe(200);
    const r = await admin.agent.get(`${api}/audit-logs`).query({ action: 'user.update' });
    expect(r.body.items).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('victim@test.com');
  });

  it('system-logs: filters by level/component/date/text, masks URL queries and redacts secret keys', async () => {
    const admin = await actor('ADMIN');
    const t0 = new Date('2026-10-01T10:00:00Z');
    await prisma.systemLog.createMany({
      data: [
        { level: 'WARN', component: 'scrape', message: 'yavaş yanıt https://src.example/list?token=abc&page=2', context: { url: 'https://src.example/x?key=secret', botToken: '123:ABC', nested: { password: 'p', ok: 1 } }, createdAt: t0 },
        { level: 'ERROR', component: 'notify-telegram', message: 'Telegram 401', createdAt: new Date(t0.getTime() + 60_000) },
        { level: 'ERROR', component: 'scrape', message: '100% başarısız', createdAt: new Date(t0.getTime() + 120_000) },
      ],
    });
    const all = await admin.agent.get(`${api}/system-logs`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((i: { message: string }) => i.message)[0]).toBe('100% başarısız');
    const warn = all.body.items.find((i: { level: string }) => i.level === 'WARN');
    expect(warn.message).toBe('yavaş yanıt https://src.example/list?…');
    expect(warn.context).toEqual({ url: 'https://src.example/x?…', botToken: '[gizli]', nested: { password: '[gizli]', ok: 1 } });
    expect(JSON.stringify(all.body)).not.toMatch(/token=abc|123:ABC|key=secret/);

    const q = (query: Record<string, unknown>) => admin.agent.get(`${api}/system-logs`).query(query);
    expect((await q({ level: 'ERROR' })).body.total).toBe(2);
    expect((await q({ component: 'scrape' })).body.total).toBe(2);
    expect((await q({ level: 'ERROR', component: 'scrape' })).body.total).toBe(1);
    expect((await q({ q: '100%' })).body.total).toBe(1);
    expect((await q({ q: '%' })).body.total).toBe(1); // yalnızca gerçek % içeren mesaj
    expect((await q({ from: new Date(t0.getTime() + 30_000).toISOString() })).body.total).toBe(2);
    expect((await q({ level: 'INFO' })).status).toBe(400);
    expect((await q({ pageSize: 101 })).status).toBe(400);
    expect((await q({ x: 1 })).status).toBe(400);
  });
});
