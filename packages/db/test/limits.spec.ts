import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveUserPlan } from '../src/limits';
import { seedPlans } from '../src/seed-data';

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = pg.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "UserSubscription","User","SubscriptionPlan" RESTART IDENTITY CASCADE');
  await seedPlans(prisma);
});

async function user() {
  return prisma.user.create({ data: { email: `u${Math.random()}@t.com`, passwordHash: 'x', name: 'U' } });
}

describe('resolveUserPlan', () => {
  it('falls back to FREE when there is no subscription', async () => {
    const u = await user();
    const r = await resolveUserPlan(prisma, u.id);
    expect(r).toMatchObject({ planCode: 'FREE', status: 'FALLBACK', endsAt: null, limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 20 } });
  });
  it('uses the live subscription with overrides, ignoring expired ones', async () => {
    const u = await user();
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await prisma.userSubscription.create({ data: { userId: u.id, planId: pro.id, endsAt: new Date(Date.now() - 1000) } });
    expect((await resolveUserPlan(prisma, u.id)).planCode).toBe('FREE');
    await prisma.userSubscription.create({ data: { userId: u.id, planId: pro.id, limitOverrides: { maxNotificationsPerDay: 7 } } });
    expect(await resolveUserPlan(prisma, u.id)).toMatchObject({ planCode: 'PRO', status: 'ACTIVE', limits: { maxNotificationsPerDay: 7, maxSearchProfiles: 10 } });
  });
});
