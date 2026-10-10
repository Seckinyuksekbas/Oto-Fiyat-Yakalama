import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, newAgent, registerUser, resetState, tokenFromMail } from './helpers';

let app: NestExpressApplication;
/** Pozitif durumlar: outbox beklenen sayıya ulaşana kadar (en çok ~5 sn) yoklanır. */
async function waitForMail(outbox: unknown[], count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (outbox.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  expect(outbox.length).toBeGreaterThanOrEqual(count);
}
/**
 * Negatif durumlar (mail GELMEMELİ): arka plan görevi için deterministik tamamlanma sinyali yok;
 * bu yüzden sınırlı 1 sn beklenir. Beklemenin kısa kalması yalnızca testi gevşetir (sahte kırmızı üretmez);
 * aynı yolun pozitif karşılığı waitForMail ile ayrıca doğrulanır.
 */
const settle = () => new Promise((r) => setTimeout(r, 1000));

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('POST /auth/resend-verification', () => {
  it('always 204; sends once per cooldown only to unverified active users; old token invalidated', async () => {
    const A = await registerUser(app);
    const outbox = app.get(MailService).outbox;
    await waitForMail(outbox, 1);
    const firstToken = tokenFromMail(outbox[0].text);
    outbox.length = 0;

    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: 'nobody@test.com' })).status).toBe(204);
    await waitForMail(outbox, 1);
    await settle(); // 2./3. istek fazladan mail üretmemeli
    expect(outbox).toHaveLength(1);

    expect((await newAgent(app).post('/api/v1/auth/verify-email').send({ token: firstToken })).status).toBe(400);
    expect((await newAgent(app).post('/api/v1/auth/verify-email').send({ token: tokenFromMail(outbox[0].text) })).status).toBe(204);
    expect((await app.get(PrismaService).user.findUniqueOrThrow({ where: { id: A.user.id } })).emailVerifiedAt).not.toBeNull();

    // Doğrulanmış kullanıcıya gönderilmez (bekleme süresi dolmuş olsa bile)
    outbox.length = 0;
    await app.get(RedisService).del(`auth:resend:${A.email.toLowerCase()}`);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    await settle();
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

  const bad = (A: Awaited<ReturnType<typeof registerUser>>, pw = 'wrong-password-x') =>
    A.agent.post('/api/v1/me/change-password').send({ currentPassword: pw, newPassword: 'another-strong-pass' });

  it('a success resets the counter', async () => {
    const A = await registerUser(app);
    for (let i = 0; i < 4; i++) expect((await bad(A)).status).toBe(400);
    expect((await A.agent.post('/api/v1/me/change-password').send({ currentPassword: A.password, newPassword: 'another-strong-pass' })).status).toBe(204);
    for (let i = 0; i < 4; i++) expect((await bad(A, 'wrong-password-y')).status).toBe(400);
  });

  it('cap holds under parallel attempts', async () => {
    const A = await registerUser(app);
    const rs = await Promise.all(Array.from({ length: 8 }, () => bad(A)));
    const statuses = rs.map((r) => r.status);
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    expect((await A.agent.post('/api/v1/me/change-password').send({ currentPassword: A.password, newPassword: 'another-strong-pass' })).status).toBe(429);
  });
});

describe('resend-verification edge cases', () => {
  it('no mail for suspended users; mixed-case email shares the cooldown', async () => {
    const A = await registerUser(app);
    const outbox = app.get(MailService).outbox;
    await waitForMail(outbox, 1);
    outbox.length = 0;
    await app.get(PrismaService).user.update({ where: { id: A.user.id }, data: { status: 'SUSPENDED' } });
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    await settle();
    expect(outbox).toHaveLength(0);

    await app.get(PrismaService).user.update({ where: { id: A.user.id }, data: { status: 'ACTIVE' } });
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email.toUpperCase() })).status).toBe(204);
    await settle();
    expect(outbox).toHaveLength(0); // same cooldown key consumed by the first request
  });
});
