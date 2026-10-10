import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MailService } from '../src/modules/mail/mail.service';
import { cookieFrom, createTestApp, newAgent, registerUser, resetState, setRole, tokenFromMail } from './helpers';

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

async function loginAgain(email: string, password: string) {
  const agent = newAgent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

describe('/me', () => {
  it('shows the FREE fallback plan when the PRO subscription has expired', async () => {
    const A = await registerUser(app);
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await prisma.userSubscription.updateMany({
      where: { userId: A.user.id },
      data: { planId: pro.id, endsAt: new Date(Date.now() - 86_400_000) },
    });
    const res = await A.agent.get('/api/v1/me');
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    expect(res.body.subscription).toMatchObject({ planCode: 'FREE', planName: free.name, status: 'FALLBACK', endsAt: null });
    expect(res.body.subscription.limits.maxSearchProfiles).toBe((free.limits as { maxSearchProfiles: number }).maxSearchProfiles);
  });

  it('PATCH /me trims the name and validates length', async () => {
    const { agent } = await registerUser(app);
    const ok = await agent.patch('/api/v1/me').send({ name: '  Yeni İsim  ' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.name).toBe('Yeni İsim');
    expect((await agent.patch('/api/v1/me').send({ name: 'x'.repeat(81) })).status).toBe(400);
  });

  it('change-password keeps the current session and kills the others', async () => {
    const { agent, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    const wrong = await agent.post('/api/v1/me/change-password').send({ currentPassword: 'not-it-at-all', newPassword: 'another-strong-pw' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const res = await agent.post('/api/v1/me/change-password').send({ currentPassword: password, newPassword: 'another-strong-pw' });
    expect(res.status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('lists sessions with a current flag and revokes one by id', async () => {
    const { agent, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    const list = await agent.get('/api/v1/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const current = list.body.items.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    const otherId = list.body.items.find((s: { current: boolean }) => !s.current).id;
    expect((await agent.delete(`/api/v1/me/sessions/${otherId}`)).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await agent.delete(`/api/v1/me/sessions/${otherId}`)).status).toBe(404);
  });

  it('DELETE /me requires the password, anonymizes and frees the email', async () => {
    const { agent, user, email, password } = await registerUser(app, { email: 'bye@test.com' });
    const other = await loginAgain(email, password);
    expect((await agent.delete('/api/v1/me').send({ password: 'not-it-at-all' })).status).toBe(400);
    const res = await agent.delete('/api/v1/me').send({ password });
    expect(res.status).toBe(204);
    expect(cookieFrom(res, 'access_token')).toBeUndefined();
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cleared = setCookie.find((c) => c.startsWith('access_token='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/^access_token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('DELETED');
    expect(row.email).toBe(`deleted+${user.id}@invalid.local`);
    expect(await prisma.notificationChannel.count({ where: { userId: user.id } })).toBe(0);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(xhr).send({ email, password });
    expect(login.status).toBe(401);
    await registerUser(app, { email: 'bye@test.com' });
  });
  it('refuses to delete the last active SUPER_ADMIN, allows it when another exists', async () => {
    const a = await registerUser(app);
    await setRole(app, a.user.id, 'SUPER_ADMIN');
    const refused = await a.agent.delete('/api/v1/me').send({ password: a.password });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_OPERATION');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).status).toBe('ACTIVE');
    const b = await registerUser(app);
    await setRole(app, b.user.id, 'SUPER_ADMIN');
    expect((await a.agent.delete('/api/v1/me').send({ password: a.password })).status).toBe(204);
  });

  it('PATCH /me from a still-valid session of a deleted account is rejected', async () => {
    const { agent, user, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    expect((await agent.delete('/api/v1/me').send({ password })).status).toBe(204);
    const res = await other.patch('/api/v1/me').send({ name: 'Hacked' });
    expect(res.status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe('Silinmiş kullanıcı');
  });

  it('account deletion removes sessions and one-time tokens', async () => {
    const { agent, user, email, password } = await registerUser(app);
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: 'h1', expiresAt: new Date(Date.now() + 1e6) } });
    await prisma.telegramLinkToken.create({ data: { userId: user.id, codeHash: 'h2', expiresAt: new Date(Date.now() + 1e6) } });
    expect(await prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBe(1);
    await loginAgain(email, password);
    expect((await agent.delete('/api/v1/me').send({ password })).status).toBe(204);
    const where = { where: { userId: user.id } };
    expect(await prisma.session.count(where)).toBe(0);
    expect(await prisma.emailVerificationToken.count(where)).toBe(0);
    expect(await prisma.passwordResetToken.count(where)).toBe(0);
    expect(await prisma.telegramLinkToken.count(where)).toBe(0);
  });

  it('change-password invalidates outstanding reset tokens', async () => {
    const { agent, password, email } = await registerUser(app);
    const mail = app.get(MailService);
    mail.outbox.length = 0;
    await request(app.getHttpServer()).post('/api/v1/auth/forgot-password').set(xhr).send({ email });
    const token = tokenFromMail(mail.outbox[0].text);
    expect((await agent.post('/api/v1/me/change-password').send({ currentPassword: password, newPassword: 'another-strong-pw' })).status).toBe(204);
    const res = await request(app.getHttpServer()).post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'third-strong-pass' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});
