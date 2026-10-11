import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@oto/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, newAgent, registerUser, resetState } from './helpers';

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

describe('refresh family absolute lifetime', () => {
  it('rejects refresh and revokes the whole family once the family is older than 90 days', async () => {
    const { agent, user } = await registerUser(app);
    await backdateFamily(user.id, 91);
    const res = await agent.post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
    const live = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);
  });

  it('still refreshes an 89-day-old family and keeps familyStartedAt across rotation', async () => {
    const { agent, user } = await registerUser(app);
    const startedAt = await backdateFamily(user.id, 89);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
    const rows = await prisma.$queryRaw<{ familyStartedAt: Date; revokedAt: Date | null }[]>`
      SELECT "familyStartedAt", "revokedAt" FROM "Session" WHERE "userId" = ${user.id}`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.familyStartedAt.getTime()).toBe(startedAt.getTime());
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });
});

describe('forgot-password cooldown', () => {
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
    const key = `auth:forgot:${createHash('sha256').update(email.toLowerCase()).digest('hex')}`;
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.keys('auth:forgot:*cool*')).toEqual([]);
    await redis.del(key);

    expect((await http().post('/api/v1/auth/forgot-password').send({ email })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.outbox).toHaveLength(2);
  });

  it('answers 204 for unknown e-mails during the cooldown as well', async () => {
    const http = () => newAgent(app);
    expect((await http().post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.com' })).status).toBe(204);
    expect((await http().post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.com' })).status).toBe(204);
  });
});

describe('interactive transaction timeout', () => {
  it('returns 503 SERVICE_BUSY when the profile advisory lock is held past the tx timeout', async () => {
    const { agent, user } = await registerUser(app);
    const url = new URL(process.env.DATABASE_URL as string);
    url.searchParams.set('connection_limit', '1');
    const holder = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await holder.$executeRaw`SELECT pg_advisory_lock(hashtext(${`profiles:${user.id}`}))`;
      const release = setTimeout(() => {
        // PrismaPromise tembeldir: then() çağrılmadan sorgu gitmez.
        holder.$executeRaw`SELECT pg_advisory_unlock_all()`.then(
          () => undefined,
          () => undefined,
        );
      }, 17_000);
      try {
        const res = await agent.post('/api/v1/me/search-profiles').send({ name: 'Kilitli' });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_BUSY');
      } finally {
        clearTimeout(release);
        await holder.$executeRaw`SELECT pg_advisory_unlock_all()`;
      }
    } finally {
      await holder.$disconnect();
    }
    expect(await prisma.searchProfile.count({ where: { userId: user.id } })).toBe(0);
  }, 60_000);
});
