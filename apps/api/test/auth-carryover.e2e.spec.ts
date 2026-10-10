import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, newAgent, registerUser, resetState, tokenFromMail } from './helpers';

let app: NestExpressApplication;
const flush = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('POST /auth/resend-verification', () => {
  it('always 204; sends once per cooldown only to unverified active users; old token invalidated', async () => {
    const A = await registerUser(app);
    await flush();
    const outbox = app.get(MailService).outbox;
    const firstToken = tokenFromMail(outbox[0].text);
    outbox.length = 0;

    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: 'nobody@test.com' })).status).toBe(204);
    await flush();
    expect(outbox).toHaveLength(1);

    expect((await newAgent(app).post('/api/v1/auth/verify-email').send({ token: firstToken })).status).toBe(400);
    expect((await newAgent(app).post('/api/v1/auth/verify-email').send({ token: tokenFromMail(outbox[0].text) })).status).toBe(204);
    expect((await app.get(PrismaService).user.findUniqueOrThrow({ where: { id: A.user.id } })).emailVerifiedAt).not.toBeNull();

    // Doğrulanmış kullanıcıya gönderilmez (bekleme süresi dolmuş olsa bile)
    outbox.length = 0;
    await app.get(RedisService).del(`auth:resend:${A.email.toLowerCase()}`);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    await flush();
    expect(outbox).toHaveLength(0);
  });
});

describe('password confirmation limiter', () => {
  it('locks sensitive /me actions after 5 wrong passwords', async () => {
    const A = await registerUser(app);
    for (let i = 0; i < 5; i++) {
      const r = await A.agent.post('/api/v1/me/change-password').send({ currentPassword: 'wrong-password-x', newPassword: 'another-strong-pass' });
      expect(r.status).toBe(400);
    }
    const locked = await A.agent.post('/api/v1/me/change-password').send({ currentPassword: A.password, newPassword: 'another-strong-pass' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect((await A.agent.delete('/api/v1/me').send({ password: A.password })).status).toBe(429);
  });
});
