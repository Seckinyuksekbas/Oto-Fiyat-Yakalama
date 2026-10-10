import type { DynamicModule, Type } from '@nestjs/common';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test, type TestingModule } from '@nestjs/testing';
import { seedMakeModelAliases, type CollectionJob, type DataSource } from '@oto/db';
import { createDemoSite, type DemoSite } from '@oto/demo-site';
import { truncateAll } from '@oto/testing';
import { CoreModule } from '../src/core.module';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';

export async function createContext(imports: (Type<unknown> | DynamicModule)[] = []): Promise<TestingModule> {
  const ref = await Test.createTestingModule({ imports: [CoreModule, ...imports] }).compile();
  await ref.init();
  return ref;
}

export async function resetState(ref: TestingModule): Promise<void> {
  const prisma = ref.get(PrismaService);
  await truncateAll(prisma);
  await ref.get(RedisService).flushdb();
  await seedMakeModelAliases(prisma);
}

export async function createAdmin(ref: TestingModule, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  return ref.get(PrismaService).user.create({
    data: { email: `admin-${Math.random().toString(36).slice(2)}@test.com`, name: 'Admin', passwordHash: 'x', role: 'ADMIN', status },
  });
}

export async function startDemo(opts: { size?: number; pageSize?: number } = {}) {
  const site: DemoSite = createDemoSite({ seed: 7, size: opts.size ?? 45, pageSize: opts.pageSize ?? 20 });
  const server = createServer(site.app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { site, baseUrl, close: () => new Promise<void>((done) => server.close(() => done())) };
}

export async function createSource(ref: TestingModule, baseUrl: string, over: Record<string, unknown> = {}): Promise<DataSource> {
  return ref.get(PrismaService).dataSource.create({
    data: {
      code: `demo-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Demo',
      adapterKey: 'demo-site',
      kind: 'HTTP',
      permissionType: 'TEST',
      permissionVerifiedAt: new Date(),
      isActive: true,
      intervalSec: 60,
      minRequestGapMs: 0,
      config: { baseUrl },
      ...over,
    },
  });
}

export async function createQueuedJob(ref: TestingModule, sourceId: number): Promise<CollectionJob> {
  return ref.get(PrismaService).collectionJob.create({ data: { sourceId, trigger: 'SCHEDULED' } });
}
