import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { cookieFrom, createTestApp, newAgent, registerUser, resetState } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const http = () => request(app.getHttpServer());
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

describe('register', () => {
  it('creates a USER with FREE plan + IN_APP channel and logs in', async () => {
    const { agent, user } = await registerUser(app, { email: 'new@test.com' });
    expect(user).toMatchObject({ email: 'new@test.com', role: 'USER' });
    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
    expect(me.body.subscription.planCode).toBe('FREE');
    expect(me.body.usage).toEqual({ searchProfiles: 0, notificationsToday: 0 });
    const channels = await prisma.notificationChannel.findMany({ where: { userId: user.id } });
    expect(channels.map((c) => c.type)).toEqual(['IN_APP']);
  });

  it('normalizes email case/whitespace and rejects case-insensitive duplicates', async () => {
    await registerUser(app, { email: '  Mixed@Example.COM ' });
    const dup = await http().post('/api/v1/auth/register').set(xhr)
      .send({ email: 'mixed@example.com', password: 'a-very-strong-pass', name: 'X', kvkkAccepted: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const login = await http().post('/api/v1/auth/login').set(xhr)
      .send({ email: 'MIXED@example.com', password: 'a-very-strong-pass' });
    expect(login.status).toBe(200);
  });

  it('rejects missing KVKK consent, unknown fields, huge names and huge passwords', async () => {
    const base = { email: 'v@test.com', password: 'a-very-strong-pass', name: 'V', kvkkAccepted: true };
    for (const body of [
      { ...base, kvkkAccepted: false },
      { ...base, role: 'SUPER_ADMIN' },
      { ...base, name: 'a'.repeat(10_000) },
      { ...base, password: 'x'.repeat(129) },
    ]) {
      const res = await http().post('/api/v1/auth/register').set(xhr).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('login', () => {
  it('returns the same error for wrong password and unknown email', async () => {
    await registerUser(app, { email: 'l@test.com' });
    const wrong = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'l@test.com', password: 'nope-nope-nope' });
    const unknown = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'x@test.com', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks after 5 failures for 15 minutes, even with the right password, and audits it', async () => {
    await registerUser(app, { email: 'lock@test.com' });
    for (let i = 0; i < 5; i++) {
      await http().post('/api/v1/auth/login').set(xhr).send({ email: 'lock@test.com', password: 'wrong-wrong-1' });
    }
    const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'lock@test.com', password: 'a-very-strong-pass' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('LOGIN_LOCKED');
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_locked' } })).toBe(1);
  });

  it('refuses suspended accounts after a correct password', async () => {
    const { user } = await registerUser(app, { email: 'sus@test.com' });
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'sus@test.com', password: 'a-very-strong-pass' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('sets httpOnly SameSite=Lax cookies with the right paths', async () => {
    await registerUser(app, { email: 'c@test.com' });
    const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'c@test.com', password: 'a-very-strong-pass' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/access_token=[^;]+;.*Path=\/;.*HttpOnly;.*SameSite=Lax/);
    expect(cookies).toMatch(/refresh_token=[^;]+;.*Path=\/api\/v1\/auth;.*HttpOnly;.*SameSite=Lax/);
  });

  it('rate limits /auth to 10 requests per minute per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: `rl${i}@test.com`, password: 'whatever-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('guards', () => {
  it('requires X-Requested-With on mutations', async () => {
    const res = await http().post('/api/v1/auth/login').send({ email: 'a@test.com', password: 'whatever-123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rejects a foreign Origin', async () => {
    const res = await http().post('/api/v1/auth/login').set(xhr).set('Origin', 'https://evil.example')
      .send({ email: 'a@test.com', password: 'whatever-123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('returns 401 (not 500) without a cookie or with a garbage cookie', async () => {
    expect((await http().get('/api/v1/me')).status).toBe(401);
    const res = await http().get('/api/v1/me').set('Cookie', 'access_token=garbage.token.value');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('refresh & logout', () => {
  it('rotates cookies; an old token after the grace window kills the family', async () => {
    const { agent, user } = await registerUser(app, { email: 'r@test.com' });
    const login = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'r@test.com', password: 'a-very-strong-pass' });
    const oldRefresh = cookieFrom(login, 'refresh_token')!;

    const rotated = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${oldRefresh}`);
    expect(rotated.status).toBe(204);
    const newRefresh = cookieFrom(rotated, 'refresh_token')!;
    expect(newRefresh).not.toBe(oldRefresh);

    const race = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${oldRefresh}`);
    expect(race.status).toBe(401);
    expect(race.body.error.code).toBe('REFRESH_RACE');

    await prisma.session.updateMany({ where: { userId: user.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    const reused = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${oldRefresh}`);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('REFRESH_REUSED');
    const after = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${newRefresh}`);
    expect(after.status).toBe(401);
    expect(await prisma.notification.count({ where: { userId: user.id, kind: 'SECURITY' } })).toBe(1);

    // registerUser'ın açtığı ayrı oturum ailesi etkilenmez
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
  });

  it('logout revokes the session and clears cookies', async () => {
    const { agent } = await registerUser(app);
    const out = await agent.post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(cookieFrom(out, 'access_token')).toBeUndefined();
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('refresh without a cookie → 401 TOKEN_INVALID', async () => {
    const res = await newAgent(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});
