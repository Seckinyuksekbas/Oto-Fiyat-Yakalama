import type { NestExpressApplication } from '@nestjs/platform-express';
import { escapeLike } from '@oto/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, seedNotification, setRole, verifyEmail } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const base = '/api/v1/admin/users';

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

async function actor(role: 'ADMIN' | 'SUPER_ADMIN') {
  const a = await registerUser(app);
  await setRole(app, a.user.id, role);
  return a;
}

async function planId(code: string) {
  return (await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code } })).id;
}

async function profiles(userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await prisma.searchProfile.create({
      data: { userId, name: `P${i}`, channels: ['IN_APP'], fuels: [], transmissions: [], cities: [], minDiscountPct: 0, createdAt: new Date(Date.now() - (n - i) * 1000) },
    });
  }
}

describe('LIKE escaping (DB-backed)', () => {
  it('Prisma contains does NOT escape wildcards itself; escapeLike makes them literal', async () => {
    let i = 0;
    for (const n of ['500', '50%', 'axb', 'a_b', 'a\\b', 'Xab']) {
      i += 1;
      await prisma.user.create({ data: { email: `like${i}@x.com`, name: n, passwordHash: 'x' } });
    }
    const find = (q: string, esc: boolean) =>
      prisma.user.findMany({ where: { name: { contains: esc ? escapeLike(q) : q, mode: 'insensitive' } }, select: { name: true }, orderBy: { name: 'asc' } });
    // Kanıt: kaçışsız '50%' joker gibi davranır
    expect((await find('50%', false)).map((u) => u.name)).toContain('500');
    expect((await find('50%', true)).map((u) => u.name)).toEqual(['50%']);
    expect((await find('a_b', true)).map((u) => u.name)).toEqual(['a_b']);
    expect((await find('a\\b', true)).map((u) => u.name)).toEqual(['a\\b']);
  });

  it('GET /admin/users?q=50% finds only literal-% names', async () => {
    const admin = await actor('ADMIN');
    await registerUser(app, { email: 'k1@test.com', name: 'Kaan 500' });
    await registerUser(app, { email: 'k2@test.com', name: 'Kaan 50%' });
    await registerUser(app, { email: 'a_b@test.com', name: 'Plain' });
    await registerUser(app, { email: 'axb@test.com', name: 'Other' });
    const pct = await admin.agent.get(base).query({ q: '50%' });
    expect(pct.body.items.map((u: { email: string }) => u.email)).toEqual(['k2@test.com']);
    const us = await admin.agent.get(base).query({ q: 'a_b' });
    expect(us.body.items.map((u: { email: string }) => u.email)).toEqual(['a_b@test.com']);
  });

  it('filters by status, role and plan', async () => {
    const admin = await actor('ADMIN');
    const pro = await registerUser(app, { email: 'pro@test.com' });
    await prisma.userSubscription.updateMany({ where: { userId: pro.user.id }, data: { status: 'CANCELED' } });
    await prisma.userSubscription.create({ data: { userId: pro.user.id, planId: await planId('PRO') } });
    await registerUser(app, { email: 'free@test.com' });
    const byPlan = await admin.agent.get(base).query({ plan: 'PRO' });
    expect(byPlan.body.items.map((u: { email: string }) => u.email)).toEqual(['pro@test.com']);
    const free = await admin.agent.get(base).query({ plan: 'FREE' });
    expect(free.body.total).toBe(2); // admin + free (abonelik yok = FREE)
    expect((await admin.agent.get(base).query({ role: 'ADMIN' })).body.total).toBe(1);
    expect((await admin.agent.get(base).query({ status: 'SUSPENDED' })).body.total).toBe(0);
  });
});

describe('GET/PATCH user', () => {
  it('detail incl. DELETED (anonymous); mutations on DELETED are 404', async () => {
    const sa = await actor('SUPER_ADMIN');
    const v = await registerUser(app, { email: 'gone@test.com' });
    expect((await sa.agent.delete(`${base}/${v.user.id}`)).status).toBe(200);
    const got = await sa.agent.get(`${base}/${v.user.id}`);
    expect(got.status).toBe(200);
    expect(got.body.user).toMatchObject({ status: 'DELETED', name: 'Silinmiş kullanıcı' });
    expect(got.body.user.email).toBe(`deleted+${v.user.id}@invalid.local`);
    expect((await sa.agent.patch(`${base}/${v.user.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await sa.agent.post(`${base}/${v.user.id}/suspend`)).status).toBe(404);
    expect((await sa.agent.patch(`${base}/${v.user.id}/role`).send({ role: 'ADMIN' })).status).toBe(404);
    expect((await sa.agent.delete(`${base}/${v.user.id}`)).status).toBe(404);
    expect((await sa.agent.get(base).query({ status: 'DELETED' })).body.total).toBe(1);
  });

  it('PATCH name: audited with before/after, no-op writes nothing, validates, 404', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { name: 'Eski' });
    const res = await admin.agent.patch(`${base}/${v.user.id}`).send({ name: 'Yeni' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Yeni');
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.update' } })).toMatchObject({ before: { name: 'Eski' }, after: { name: 'Yeni' } });
    await admin.agent.patch(`${base}/${v.user.id}`).send({ name: 'Yeni' });
    expect(await prisma.auditLog.count({ where: { action: 'user.update' } })).toBe(1);
    expect((await admin.agent.patch(`${base}/${v.user.id}`).send({ name: '' })).status).toBe(400);
    expect((await admin.agent.patch(`${base}/${v.user.id}`).send({ name: 'a', role: 'ADMIN' })).status).toBe(400);
    expect((await admin.agent.patch(`${base}/nope`).send({ name: 'a' })).status).toBe(404);
  });

  it('ADMIN cannot touch a SUPER_ADMIN (patch/subscription/suspend) -> 403', async () => {
    const admin = await actor('ADMIN');
    const boss = await actor('SUPER_ADMIN');
    expect((await admin.agent.patch(`${base}/${boss.user.id}`).send({ name: 'x' })).status).toBe(403);
    expect((await admin.agent.post(`${base}/${boss.user.id}/suspend`)).status).toBe(403);
    expect((await admin.agent.patch(`${base}/${boss.user.id}/subscription`).send({ planId: await planId('PRO'), endsAt: null, limitOverrides: null })).status).toBe(403);
  });
});

describe('suspend / activate', () => {
  it('suspend fails PENDING notifications (USER_INACTIVE) and they leave the daily quota; sessions revoked', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'susp@test.com' });
    const pending = await seedNotification(app, v.user.id, { kind: 'MATCH', channel: 'TELEGRAM', status: 'PENDING' });
    const sent = await seedNotification(app, v.user.id, { kind: 'MATCH', channel: 'TELEGRAM', status: 'SENT' });
    expect((await admin.agent.get(`${base}/${v.user.id}/usage`)).body.notificationsToday).toBe(2);
    expect((await admin.agent.post(`${base}/${v.user.id}/suspend`)).status).toBe(200);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'FAILED', lastError: 'USER_INACTIVE' });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('SENT');
    expect((await admin.agent.get(`${base}/${v.user.id}/usage`)).body.notificationsToday).toBe(1);
    expect(await prisma.session.count({ where: { userId: v.user.id, revokedAt: null } })).toBe(0);
  });

  it('concurrent suspends: exactly one audit row, all 200', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'race@test.com' });
    const rs = await Promise.all([1, 2, 3].map(() => admin.agent.post(`${base}/${v.user.id}/suspend`)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    const logs = await prisma.auditLog.findMany({ where: { action: 'user.suspend' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].before).toEqual({ status: 'ACTIVE' });
  });

  it('no-op suspend still revokes sessions (retry of a failed revoke)', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'retry@test.com' });
    await prisma.user.update({ where: { id: v.user.id }, data: { status: 'SUSPENDED' } });
    expect(await prisma.session.count({ where: { userId: v.user.id, revokedAt: null } })).toBeGreaterThan(0);
    expect((await admin.agent.post(`${base}/${v.user.id}/suspend`)).status).toBe(200);
    expect(await prisma.session.count({ where: { userId: v.user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'user.suspend' } })).toBe(0);
  });

  it('a second super can suspend the first; the remaining last super cannot suspend self (409)', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    expect((await a.agent.post(`${base}/${b.user.id}/suspend`)).status).toBe(200);
    expect((await a.agent.post(`${base}/${a.user.id}/suspend`)).status).toBe(409);
  });
});

describe('role changes', () => {
  it('SUPER_ADMIN changes roles with audit; ADMIN -> 403; self -> 409; no-op writes no audit', async () => {
    const sa = await actor('SUPER_ADMIN');
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'role@test.com' });
    expect((await admin.agent.patch(`${base}/${v.user.id}/role`).send({ role: 'ADMIN' })).status).toBe(403);
    const ok = await sa.agent.patch(`${base}/${v.user.id}/role`).send({ role: 'ADMIN' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('ADMIN');
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.role' } })).toMatchObject({ before: { role: 'USER' }, after: { role: 'ADMIN' } });
    await sa.agent.patch(`${base}/${v.user.id}/role`).send({ role: 'ADMIN' });
    expect(await prisma.auditLog.count({ where: { action: 'user.role' } })).toBe(1);
    expect((await sa.agent.patch(`${base}/${sa.user.id}/role`).send({ role: 'ADMIN' })).status).toBe(409);
    expect((await sa.agent.patch(`${base}/${v.user.id}/role`).send({ role: 'ROOT' })).status).toBe(400);
    expect((await sa.agent.patch(`${base}/nope/role`).send({ role: 'ADMIN' })).status).toBe(404);
  });

  it('concurrent demotion of the two remaining SUPER_ADMINs: only one succeeds, >=1 SUPER_ADMIN remains', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    const [r1, r2] = await Promise.all([
      a.agent.patch(`${base}/${b.user.id}/role`).send({ role: 'ADMIN' }),
      b.agent.patch(`${base}/${a.user.id}/role`).send({ role: 'ADMIN' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditLog.count({ where: { action: 'user.role' } })).toBe(1);
  });

  it('concurrent delete + demote of the last two supers: statuses {200,409}, one audit row of the winner, one super remains', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    const [r1, r2] = await Promise.all([
      a.agent.delete(`${base}/${b.user.id}`),
      b.agent.patch(`${base}/${a.user.id}/role`).send({ role: 'USER' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
    const winner = r1.status === 200 ? 'user.delete' : 'user.role';
    const loser = r1.status === 200 ? 'user.role' : 'user.delete';
    expect(await prisma.auditLog.count({ where: { action: winner } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: loser } })).toBe(0);
  });

  it('concurrent suspend vs suspend between the last two supers: one 200, one 409, one super stays ACTIVE', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    const [r1, r2] = await Promise.all([
      a.agent.post(`${base}/${b.user.id}/suspend`),
      b.agent.post(`${base}/${a.user.id}/suspend`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'user.suspend' } })).toBe(1);
  });

  it('concurrent suspend vs delete between the last two supers: one 200, one 409', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    const [r1, r2] = await Promise.all([
      a.agent.post(`${base}/${b.user.id}/suspend`),
      b.agent.delete(`${base}/${a.user.id}`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { in: ['user.suspend', 'user.delete'] } } })).toBe(1);
  });

  it('/me self-delete: two supers deleting themselves at once -> one 204, one 409', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    const [r1, r2] = await Promise.all([
      a.agent.delete('/api/v1/me').send({ password: a.password }),
      b.agent.delete('/api/v1/me').send({ password: b.password }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([204, 409]);
    expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
  });

  it('/me self-delete racing an admin demotion of the other super never leaves zero supers', async () => {
    const a = await actor('SUPER_ADMIN');
    const b = await actor('SUPER_ADMIN');
    await Promise.all([
      a.agent.delete('/api/v1/me').send({ password: a.password }),
      b.agent.patch(`${base}/${a.user.id}/role`).send({ role: 'USER' }),
    ]);
    expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBeGreaterThanOrEqual(1);
  });
});

describe('delete (KVKK)', () => {
  it('anonymizes with the same rules as self-delete; audited; SUPER_ADMIN only; self 409; last super kept', async () => {
    const sa = await actor('SUPER_ADMIN');
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'kvkk@test.com' });
    await profiles(v.user.id, 1);
    await prisma.notificationChannel.create({ data: { userId: v.user.id, type: 'TELEGRAM', config: 'enc' } });
    const pend = await seedNotification(app, v.user.id, { kind: 'MATCH', channel: 'TELEGRAM', status: 'PENDING' });
    await sa.agent.patch(`${base}/${v.user.id}`).send({ name: 'PII Isim' });
    expect((await admin.agent.delete(`${base}/${v.user.id}`)).status).toBe(403);
    expect((await sa.agent.delete(`${base}/${sa.user.id}`)).status).toBe(409);
    const res = await sa.agent.delete(`${base}/${v.user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('DELETED');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: v.user.id } });
    expect(row).toMatchObject({ passwordHash: '', name: 'Silinmiş kullanıcı', emailVerifiedAt: null });
    expect(await prisma.searchProfile.count({ where: { userId: v.user.id } })).toBe(0);
    expect(await prisma.notificationChannel.count({ where: { userId: v.user.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: v.user.id } })).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.delete' } });
    expect(JSON.stringify(log)).not.toContain('kvkk@test.com');
    expect(log).toMatchObject({ targetId: v.user.id, before: { status: 'ACTIVE', role: 'USER' }, after: { status: 'DELETED' } });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: pend.id } })).toMatchObject({ status: 'FAILED', lastError: 'USER_INACTIVE' });
    const earlier = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.update', targetId: v.user.id } });
    expect(earlier.before).toEqual({ redacted: true });
    expect(earlier.after).toEqual({ redacted: true });
    const sb = await actor('SUPER_ADMIN');
    expect((await sa.agent.delete(`${base}/${sb.user.id}`)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: sa.user.id } })).status).toBe('ACTIVE');
  });
});

describe('sub-resources', () => {
  it('search-profiles, notifications (paged), usage; 404 for unknown; ADMIN allowed', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'sub@test.com' });
    await profiles(v.user.id, 3);
    await prisma.searchProfile.updateMany({ where: { userId: v.user.id, name: 'P0' }, data: { status: 'PAUSED' } });
    for (let i = 0; i < 3; i++) await seedNotification(app, v.user.id, {});
    const sp = await admin.agent.get(`${base}/${v.user.id}/search-profiles`);
    expect(sp.status).toBe(200);
    expect(sp.body.items).toHaveLength(3);
    const n = await admin.agent.get(`${base}/${v.user.id}/notifications`).query({ page: 2, pageSize: 2 });
    expect(n.body.total).toBe(3);
    expect(n.body.items).toHaveLength(1);
    expect((await admin.agent.get(`${base}/${v.user.id}/notifications`).query({ pageSize: 500 })).status).toBe(400);
    const u = await admin.agent.get(`${base}/${v.user.id}/usage`);
    expect(u.body).toMatchObject({ searchProfiles: 3, activeProfiles: 2, notificationsToday: 0, matches7d: 0, plan: { code: 'FREE' } });
    for (const p of ['search-profiles', 'notifications', 'usage']) {
      expect((await admin.agent.get(`${base}/nope/${p}`)).status).toBe(404);
    }
  });
});

describe('subscription change', () => {
  it('cancels previous ACTIVE, pauses excess newest-first, notifies user, audit has before/after plan codes', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'plan@test.com' });
    await verifyEmail(app, v.user.id);
    const pro = await prisma.userSubscription.create({ data: { userId: v.user.id, planId: await planId('PRO') } });
    await profiles(v.user.id, 5);
    const res = await admin.agent
      .patch(`${base}/${v.user.id}/subscription`)
      .send({ planId: await planId('FREE'), endsAt: null, limitOverrides: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ planCode: 'FREE', pausedProfiles: 3 });
    expect((await prisma.userSubscription.findUniqueOrThrow({ where: { id: pro.id } })).status).toBe('CANCELED');
    expect(await prisma.userSubscription.count({ where: { userId: v.user.id, status: 'ACTIVE' } })).toBe(1);
    const ps = await prisma.searchProfile.findMany({ where: { userId: v.user.id }, orderBy: { createdAt: 'asc' } });
    expect(ps.map((p) => p.status)).toEqual(['ACTIVE', 'ACTIVE', 'PAUSED', 'PAUSED', 'PAUSED']);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: v.user.id, kind: 'SYSTEM_ALERT' } });
    expect(note).toMatchObject({ channel: 'IN_APP', status: 'SENT', payload: expect.objectContaining({ type: 'PROFILES_PAUSED', count: 3 }) });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.subscription' } });
    expect(log.before).toMatchObject({ planCode: 'PRO' });
    expect(log.after).toMatchObject({ planCode: 'FREE', pausedProfiles: 3 });
  });

  it('limitOverrides validated; unknown plan 404; past endsAt 400; no pause when within limit', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'ov@test.com' });
    const url = `${base}/${v.user.id}/subscription`;
    const pro = await planId('PRO');
    expect((await admin.agent.patch(url).send({ planId: pro, endsAt: null, limitOverrides: { channels: ['EMAIL'] } })).status).toBe(400);
    expect((await admin.agent.patch(url).send({ planId: pro, endsAt: null, limitOverrides: { bogus: 1 } })).status).toBe(400);
    const unknown = await admin.agent.patch(url).send({ planId: 'nope', endsAt: null, limitOverrides: null });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('VALIDATION_FAILED');
    expect((await admin.agent.patch(url).send({ planId: pro, endsAt: '2020-01-01T00:00:00.000Z', limitOverrides: null })).status).toBe(400);
    expect((await admin.agent.patch(`${base}/nope/subscription`).send({ planId: pro, endsAt: null, limitOverrides: null })).status).toBe(404);
    await prisma.subscriptionPlan.update({ where: { id: await planId('BUSINESS') }, data: { isActive: false } });
    const inactive = await admin.agent.patch(url).send({ planId: await planId('BUSINESS'), endsAt: null, limitOverrides: null });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('INVALID_OPERATION');
    const ok = await admin.agent.patch(url).send({ planId: pro, endsAt: null, limitOverrides: { maxSearchProfiles: 4 } });
    expect(ok.status).toBe(200);
    expect(ok.body.pausedProfiles).toBe(0);
    expect((await admin.agent.get(`${base}/${v.user.id}/usage`)).body.plan.limits.maxSearchProfiles).toBe(4);
    expect(await prisma.notification.count({ where: { userId: v.user.id, kind: 'SYSTEM_ALERT' } })).toBe(0);
  });

  it('unverified-email user is capped at 1 active profile (same rule as LimitsService/sweep)', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'unv@test.com' });
    await profiles(v.user.id, 3);
    const res = await admin.agent.patch(`${base}/${v.user.id}/subscription`).send({ planId: await planId('PRO'), endsAt: null, limitOverrides: null });
    expect(res.body.pausedProfiles).toBe(2);
    expect(await prisma.searchProfile.count({ where: { userId: v.user.id, status: 'ACTIVE' } })).toBe(1);
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: v.user.id, kind: 'SYSTEM_ALERT' } })).payload).toMatchObject({ count: 2 });
  });

  it('an admin cannot change their own subscription (409)', async () => {
    const admin = await actor('ADMIN');
    const res = await admin.agent.patch(`${base}/${admin.user.id}/subscription`).send({ planId: await planId('PRO'), endsAt: null, limitOverrides: null });
    expect(res.status).toBe(409);
  });
});

describe('live-plan semantics and quota NULL-safety', () => {
  it('expired ACTIVE subscription falls back to FREE in list planCode and plan filter', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'exp@test.com' });
    await prisma.userSubscription.updateMany({ where: { userId: v.user.id }, data: { status: 'CANCELED' } });
    await prisma.userSubscription.create({ data: { userId: v.user.id, planId: await planId('PRO'), endsAt: new Date(Date.now() - 1000) } });
    const row = (await admin.agent.get(base).query({ q: 'exp@' })).body.items[0];
    expect(row.planCode).toBe('FREE');
    expect((await admin.agent.get(base).query({ plan: 'PRO' })).body.total).toBe(0);
    expect((await admin.agent.get(base).query({ plan: 'FREE', q: 'exp@' })).body.total).toBe(1);
  });

  it('FAILED rows with NULL lastError still count toward the quota; USER_INACTIVE ones do not', async () => {
    const admin = await actor('ADMIN');
    const v = await registerUser(app, { email: 'q@test.com' });
    await seedNotification(app, v.user.id, { kind: 'MATCH', channel: 'TELEGRAM', status: 'FAILED', lastError: null });
    await seedNotification(app, v.user.id, { kind: 'MATCH', channel: 'TELEGRAM', status: 'FAILED', lastError: 'boom' });
    await seedNotification(app, v.user.id, { kind: 'MATCH', channel: 'TELEGRAM', status: 'FAILED', lastError: 'USER_INACTIVE' });
    expect((await admin.agent.get(`${base}/${v.user.id}/usage`)).body.notificationsToday).toBe(2);
  });
});
