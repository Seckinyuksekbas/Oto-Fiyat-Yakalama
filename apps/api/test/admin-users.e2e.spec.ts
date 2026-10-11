import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { vi } from 'vitest';
import { AuditService } from '../src/common/audit/audit.service';
import { SessionService } from '../src/modules/auth/session.service';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

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

describe('RBAC', () => {
  it('USER gets 403, ADMIN gets 200 without re-login (role read from DB)', async () => {
    const u = await registerUser(app);
    expect((await u.agent.get('/api/v1/admin/users')).status).toBe(403);
    await setRole(app, u.user.id, 'ADMIN');
    const res = await u.agent.get('/api/v1/admin/users');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, items: [expect.objectContaining({ id: u.user.id, planCode: 'FREE' })] });
  });

  it('a demoted admin with a still-valid ADMIN token is refused', async () => {
    const a = await registerUser(app);
    await setRole(app, a.user.id, 'ADMIN');
    const relog = await a.agent.post('/api/v1/auth/login').send({ email: a.email, password: a.password });
    expect(relog.status).toBe(200);
    await setRole(app, a.user.id, 'USER');
    expect((await a.agent.get('/api/v1/admin/users')).status).toBe(403);
  });

  it('a suspended admin with a still-valid token gets 401 on admin routes', async () => {
    const a = await registerUser(app);
    await setRole(app, a.user.id, 'ADMIN');
    await prisma.user.update({ where: { id: a.user.id }, data: { status: 'SUSPENDED' } });
    expect((await a.agent.get('/api/v1/admin/users')).status).toBe(401);
  });
});

describe('admin users', () => {
  it('searches by email/name case-insensitively and validates paging', async () => {
    const admin = await registerUser(app, { name: 'Yönetici' });
    await setRole(app, admin.user.id, 'ADMIN');
    await registerUser(app, { email: 'zeynep@test.com', name: 'Zeynep' });
    const res = await admin.agent.get('/api/v1/admin/users').query({ q: 'ZEYN' });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].email).toBe('zeynep@test.com');
    expect((await admin.agent.get('/api/v1/admin/users').query({ pageSize: 101 })).status).toBe(400);
  });

  it('suspends a user: login blocked, refresh dead, audit written with before/after', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const victim = await registerUser(app, { email: 'victim@test.com' });

    const res = await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`);
    expect(res.status).toBe(201);
    expect(res.body.user.status).toBe('SUSPENDED');

    expect((await victim.agent.post('/api/v1/auth/refresh')).status).toBe(401);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(xhr)
      .send({ email: 'victim@test.com', password: victim.password });
    expect(login.status).toBe(403);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.suspend' } });
    expect(log).toMatchObject({
      actorId: admin.user.id,
      targetType: 'User',
      targetId: victim.user.id,
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
    });

    expect((await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/activate`)).body.user.status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { action: 'user.activate' } })).toBe(1);
  });

  it('ADMIN cannot suspend a SUPER_ADMIN; nobody can suspend themselves', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const boss = await registerUser(app);
    await setRole(app, boss.user.id, 'SUPER_ADMIN');
    expect((await admin.agent.post(`/api/v1/admin/users/${boss.user.id}/suspend`)).status).toBe(403);
    const self = await boss.agent.post(`/api/v1/admin/users/${boss.user.id}/suspend`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('INVALID_OPERATION');
  });

  it('unknown user id → 404', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    expect((await admin.agent.get('/api/v1/admin/users/does-not-exist')).status).toBe(404);
    expect((await admin.agent.post('/api/v1/admin/users/does-not-exist/suspend')).status).toBe(404);
  });
});

describe('admin users: atomic audit', () => {
  it('no-op suspend/activate writes no audit and no change', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const victim = await registerUser(app, { email: 'noop@test.com' });

    const act = await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/activate`);
    expect(act.body.user.status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { action: 'user.activate' } })).toBe(0);

    await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`);
    const again = await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`);
    expect(again.body.user.status).toBe('SUSPENDED');
    expect(await prisma.auditLog.count({ where: { action: 'user.suspend' } })).toBe(1);
  });

  it('audit write failing inside the transaction rolls back the status change', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const victim = await registerUser(app, { email: 'atomic@test.com' });
    const spy = vi.spyOn(app.get(AuditService), 'recordInTx').mockRejectedValueOnce(new Error('audit down'));
    try {
      const res = await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`);
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.user.id } })).status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { action: 'user.suspend' } })).toBe(0);
    expect((await prisma.session.count({ where: { userId: victim.user.id, revokedAt: null } }))).toBeGreaterThan(0);
  });

  it('audit row is committed with the status change (same transaction client)', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const victim = await registerUser(app, { email: 'tx@test.com' });
    const audit = app.get(AuditService);
    const orig = audit.recordInTx.bind(audit);
    let sawTxClient = false;
    const spy = vi.spyOn(audit, 'recordInTx').mockImplementation(async (tx, ctx, e) => {
      sawTxClient = tx !== (prisma as unknown);
      // Tx içinde görünür: durum değişimi aynı tx'te yapılmış olmalı
      const row = await tx.user.findUniqueOrThrow({ where: { id: victim.user.id } });
      expect(row.status).toBe('SUSPENDED');
      // Tx dışından henüz görünmez
      expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.user.id } })).status).toBe('ACTIVE');
      return orig(tx, ctx, e);
    });
    try {
      expect((await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`)).status).toBe(201);
    } finally {
      spy.mockRestore();
    }
    expect(sawTxClient).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'user.suspend' } })).toBe(1);
  });

  it('session revoke failure after commit is logged, not fatal: status and audit persist', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const victim = await registerUser(app, { email: 'revoke@test.com' });
    const spy = vi.spyOn(app.get(SessionService), 'revokeAllForUser').mockRejectedValueOnce(new Error('redis down'));
    try {
      const res = await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`);
      expect(res.status).toBe(201);
      expect(res.body.user.status).toBe('SUSPENDED');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.auditLog.count({ where: { action: 'user.suspend' } })).toBe(1);
  });
});
