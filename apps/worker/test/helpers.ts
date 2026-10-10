import type { DynamicModule, Type } from '@nestjs/common';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test, type TestingModule } from '@nestjs/testing';
import { seedMakeModelAliases, type CollectionJob, type DataSource, type Listing, type ListingAnalysis, type SearchProfile, type User } from '@oto/db';
import { createDemoSite, type DemoSite } from '@oto/demo-site';
import { truncateAll } from '@oto/testing';
import { CoreModule } from '../src/core.module';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';

export async function createContext(imports: (Type<unknown> | DynamicModule)[] = []): Promise<TestingModule> {
  // compile() installs a TestingLogger that prints errors; use a silent logger so intentional error paths stay quiet.
  const silent = { log: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined, verbose: () => undefined };
  const ref = await Test.createTestingModule({ imports: [CoreModule, ...imports] }).setLogger(silent).compile();
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

let listingSeq = 0;
export async function createListing(ref: TestingModule, sourceId: number, over: Record<string, unknown> = {}): Promise<Listing> {
  listingSeq += 1;
  return ref.get(PrismaService).listing.create({
    data: {
      sourceId,
      externalId: `T${listingSeq}`,
      url: `http://demo/ilan/T${listingSeq}`,
      title: `İlan T${listingSeq}`,
      make: 'BMW',
      model: '3 Serisi',
      trim: '318i',
      year: 2019,
      km: 85_000,
      fuel: 'GASOLINE',
      transmission: 'AUTOMATIC',
      price: 1_200_000n,
      contentHash: `h${listingSeq}`,
      ...over,
    },
  });
}
let userSeq = 0;
export async function createUser(ref: TestingModule, over: Record<string, unknown> = {}): Promise<User> {
  userSeq += 1;
  return ref.get(PrismaService).user.create({ data: { email: `w${userSeq}@test.com`, passwordHash: 'x', name: `U${userSeq}`, ...over } });
}

export async function createProfile(ref: TestingModule, userId: string, over: Record<string, unknown> = {}): Promise<SearchProfile> {
  return ref.get(PrismaService).searchProfile.create({ data: { userId, name: 'Profil', channels: ['IN_APP'], fuels: [], transmissions: [], cities: [], minDiscountPct: 0, ...over } });
}

/** Analiz satırı yazar ve ilanın latestAnalysisId'sini günceller. */
export async function createAnalysis(ref: TestingModule, listingId: number, over: Record<string, unknown> = {}): Promise<ListingAnalysis> {
  const prisma = ref.get(PrismaService);
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
  const a = await prisma.listingAnalysis.create({
    data: {
      listingId, engineVersion: 'rules-v1', estimatedPrice: 1_200_000n, priceDiff: 240_000n, discountPct: 0.2, opportunityScore: 77,
      comparableCount: 14, confidence: 'HIGH', flags: [], explanation: {}, comparableIds: [], listingPrice: listing.price,
      listingContentHash: listing.contentHash, ...over,
    },
  });
  await prisma.listing.update({ where: { id: listingId }, data: { latestAnalysisId: a.id } });
  return a;
}
