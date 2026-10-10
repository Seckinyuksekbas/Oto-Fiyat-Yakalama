import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPlans, seedSuperAdmin } from '../src/seed-data';

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

describe('schema', () => {
  it('seedPlans is idempotent and creates FREE/PRO/BUSINESS', async () => {
    await seedPlans(prisma);
    await seedPlans(prisma);
    const plans = await prisma.subscriptionPlan.findMany({ orderBy: { code: 'asc' } });
    expect(plans.map((p) => p.code)).toEqual(['BUSINESS', 'FREE', 'PRO']);
    const free = plans.find((p) => p.code === 'FREE')!;
    expect(free.limits).toMatchObject({ maxSearchProfiles: 2, maxNotificationsPerDay: 20 });
  });

  it('refuses to activate a data source without verified permission', async () => {
    await expect(
      prisma.dataSource.create({
        data: { code: 'x', name: 'X', adapterKey: 'x', kind: 'HTTP', permissionType: 'TEST', isActive: true },
      }),
    ).rejects.toThrow(/DataSource_active_requires_permission/);
  });

  it('enforces one listing per (source, externalId)', async () => {
    const src = await prisma.dataSource.create({
      data: { code: 'demo', name: 'Demo', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST' },
    });
    const data = {
      sourceId: src.id, externalId: 'A1', url: 'http://x/1', title: 't', make: 'BMW', model: '3 Serisi',
      year: 2019, km: 85000, fuel: 'GASOLINE' as const, transmission: 'AUTOMATIC' as const,
      price: 960000n, contentHash: 'h',
    };
    await prisma.listing.create({ data });
    await expect(prisma.listing.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('treats emails case-insensitively', async () => {
    await prisma.user.create({ data: { email: 'Case@Test.com', name: 'a', passwordHash: 'x' } });
    await expect(
      prisma.user.create({ data: { email: 'case@test.com', name: 'b', passwordHash: 'x' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('seedSuperAdmin is idempotent and never overwrites the password', async () => {
    const first = await seedSuperAdmin(prisma, { email: ' Boss@Example.com ', password: 'first-password-1', name: 'Boss' });
    const second = await seedSuperAdmin(prisma, { email: 'boss@example.com', password: 'other-password-2', name: 'Boss' });
    expect(second.id).toBe(first.id);
    expect(second.role).toBe('SUPER_ADMIN');
    expect(await argon2.verify(second.passwordHash, 'first-password-1')).toBe(true);
    const subs = await prisma.userSubscription.count({ where: { userId: first.id } });
    expect(subs).toBe(1);
  });
});
