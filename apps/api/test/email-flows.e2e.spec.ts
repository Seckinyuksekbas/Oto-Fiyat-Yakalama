import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, registerUser, resetState, tokenFromMail } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let mail: MailService;
const http = () => request(app.getHttpServer());
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

describe('email verification', () => {
  it('register sends a link; verifying marks the user and the token is single-use', async () => {
    const { user } = await registerUser(app, { email: 'verify@test.com' });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0].to).toBe('verify@test.com');
    expect(mail.outbox[0].text).toContain('http://localhost:3000/verify-email?token=');
    const token = tokenFromMail(mail.outbox[0].text);

    expect((await http().post('/api/v1/auth/verify-email').set(xhr).send({ token })).status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();

    const again = await http().post('/api/v1/auth/verify-email').set(xhr).send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired verification token', async () => {
    await registerUser(app, { email: 'exp@test.com' });
    await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const res = await http().post('/api/v1/auth/verify-email').set(xhr).send({ token: tokenFromMail(mail.outbox[0].text) });
    expect(res.status).toBe(400);
  });
});

describe('password reset', () => {
  it('always answers 204 and sends nothing for unknown emails', async () => {
    const res = await http().post('/api/v1/auth/forgot-password').set(xhr).send({ email: 'ghost@test.com' });
    expect(res.status).toBe(204);
    expect(mail.outbox).toHaveLength(0);
  });

  it('resets the password, revokes every session and audits', async () => {
    const { agent, user } = await registerUser(app, { email: 'reset@test.com' });
    mail.outbox.length = 0;
    expect((await http().post('/api/v1/auth/forgot-password').set(xhr).send({ email: 'RESET@test.com' })).status).toBe(204);
    expect(mail.outbox).toHaveLength(1);
    const token = tokenFromMail(mail.outbox[0].text);

    const weak = await http().post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);

    expect((await http().post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'brand-new-password' })).status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
    const oldLogin = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'reset@test.com', password: 'a-very-strong-pass' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'reset@test.com', password: 'brand-new-password' });
    expect(newLogin.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'auth.password_reset', targetId: user.id } })).toBe(1);

    const reuse = await http().post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'another-password-9' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired reset token', async () => {
    await registerUser(app, { email: 'old@test.com' });
    mail.outbox.length = 0;
    await http().post('/api/v1/auth/forgot-password').set(xhr).send({ email: 'old@test.com' });
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const res = await http().post('/api/v1/auth/reset-password').set(xhr)
      .send({ token: tokenFromMail(mail.outbox[0].text), newPassword: 'brand-new-password' });
    expect(res.status).toBe(400);
  });
});
