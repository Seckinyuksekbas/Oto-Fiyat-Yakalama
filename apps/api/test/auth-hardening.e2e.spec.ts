import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@oto/db';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, newAgent, registerUser, resetState, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

async function backdateFamily(userId: string, days: number): Promise<Date> {
  const startedAt = new Date(Date.now() - days * DAY);
  await prisma.$executeRaw`UPDATE "Session" SET "familyStartedAt" = ${startedAt} WHERE "userId" = ${userId}`;
  return startedAt;
}

function setCookies(res: request.Response): string[] {
  return (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
}

describe('refresh family absolute lifetime', () => {
  it('rejects refresh, clears the cookie and revokes the whole family once the family is older than 90 days', async () => {
    const { agent, user } = await registerUser(app);
    await backdateFamily(user.id, 91);
    const res = await agent.post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
    const cleared = setCookies(res).find((c) => c.startsWith('refresh_token='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/^refresh_token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    const live = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);
  });

  it('still refreshes an 89-day-old family and keeps familyStartedAt across rotation', async () => {
    const { agent, user } = await registerUser(app);
    const startedAt = await backdateFamily(user.id, 89);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
    const rows = await prisma.session.findMany({ where: { userId: user.id }, select: { familyStartedAt: true, revokedAt: true } });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.familyStartedAt.getTime()).toBe(startedAt.getTime());
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });
});

describe('forgot-password cooldown', () => {
  const forgotKey = (email: string) => `auth:forgot:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

  it('sends one mail for two quick requests and another after the cooldown key is gone', async () => {
    const { email } = await registerUser(app, { email: 'cool@test.com' });
    const mail = app.get(MailService);
    mail.outbox.length = 0;
    const http = () => newAgent(app);
    const a = await http().post('/api/v1/auth/forgot-password').send({ email });
    const b = await http().post('/api/v1/auth/forgot-password').send({ email: email.toUpperCase() });
    expect([a.status, b.status]).toEqual([204, 204]);
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.outbox).toHaveLength(1);

    const redis = app.get(RedisService);
    const stored = await redis.keys('auth:forgot:*');
    expect(stored).toEqual([forgotKey(email)]);
    expect(stored.some((k) => k.includes('@'))).toBe(false);
    const ttl = await redis.ttl(forgotKey(email));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await redis.del(forgotKey(email));

    expect((await http().post('/api/v1/auth/forgot-password').send({ email })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.outbox).toHaveLength(2);
  });

  it('answers 204 for unknown e-mails during the cooldown as well', async () => {
    const http = () => newAgent(app);
    expect((await http().post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.com' })).status).toBe(204);
    expect((await http().post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.com' })).status).toBe(204);
  });

  it('fails open when Redis is unavailable: still 204 and the mail is sent', async () => {
    const { email } = await registerUser(app, { email: 'redis-down@test.com' });
    const mail = app.get(MailService);
    mail.outbox.length = 0;
    const spy = vi.spyOn(app.get(RedisService), 'set').mockRejectedValueOnce(new Error('redis down'));
    try {
      expect((await newAgent(app).post('/api/v1/auth/forgot-password').send({ email })).status).toBe(204);
      await new Promise((r) => setTimeout(r, 50));
      expect(mail.outbox).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('bounded lock waits → 503 SERVICE_BUSY', () => {
  let holder: PrismaClient;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL as string);
    url.searchParams.set('connection_limit', '1');
    holder = new PrismaClient({ datasourceUrl: url.toString() });
  });
  afterAll(async () => holder.$disconnect());

  /** Ayrı bir bağlantıda `User` satır kilidini `fn` boyunca tutar; yalnız `finally`'de bırakır. */
  async function withUserRowLocked<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const held = holder.$transaction(
      async (t) => {
        await t.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        locked();
        await gate;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    await Promise.race([ready, held]);
    try {
      return await fn();
    } finally {
      release();
      await held;
    }
  }

  function expectBusy(res: request.Response, startedAt: number): void {
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_BUSY');
    expect(res.headers['retry-after']).toBe('5');
  }

  it('profile create: advisory lock held for the whole request', async () => {
    const { agent, user } = await registerUser(app);
    const lockKey = `profiles:${user.id}`;
    await holder.$executeRaw`SELECT pg_advisory_lock(hashtext(${lockKey}))`;
    try {
      const t0 = Date.now();
      const res = await agent.post('/api/v1/me/search-profiles').send({ name: 'Kilitli' });
      expectBusy(res, t0);
    } finally {
      await holder.$executeRaw`SELECT pg_advisory_unlock_all()`;
    }
    expect(await prisma.searchProfile.count({ where: { userId: user.id } })).toBe(0);
  });

  it('admin suspend: target user row locked for the whole request', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'SUPER_ADMIN');
    const target = await registerUser(app);
    await withUserRowLocked(target.user.id, async () => {
      const t0 = Date.now();
      const res = await admin.agent.post(`/api/v1/admin/users/${target.user.id}/suspend`);
      expectBusy(res, t0);
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).status).toBe('ACTIVE');
  });

  it('account deletion (heavy tx): own row locked for the whole request', async () => {
    const { agent, user, password } = await registerUser(app);
    await withUserRowLocked(user.id, async () => {
      const t0 = Date.now();
      const res = await agent.delete('/api/v1/me').send({ password });
      expectBusy(res, t0);
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('ACTIVE');
  });
});
