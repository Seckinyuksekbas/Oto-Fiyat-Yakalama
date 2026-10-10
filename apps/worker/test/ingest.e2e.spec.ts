import type { TestingModule } from '@nestjs/testing';
import type { NormalizedListing } from '@oto/collection';
import { contentHash } from '@oto/collection';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AliasService } from '../src/collection/alias.service';
import { CollectionModule } from '../src/collection/collection.module';
import { analyzeJobId, IngestService } from '../src/collection/ingest.service';
import { PrismaService } from '../src/infra/prisma.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createContext, resetState } from './helpers';

let ref: TestingModule;
let ingest: IngestService;
let prisma: PrismaService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([CollectionModule]);
  ingest = ref.get(IngestService);
  prisma = ref.get(PrismaService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await prisma.dataSource.create({ data: { code: 'demo', name: 'Demo', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST' } })).id;
});

function listing(over: Partial<NormalizedListing> = {}): NormalizedListing {
  const base: Omit<NormalizedListing, 'contentHash'> = {
    externalId: 'D000001', url: 'http://demo/ilan/D000001', title: '2019 BMW 3 Serisi 320i',
    make: 'BMW', model: '3 Serisi', trim: '320i', year: 2019, km: 85_000, price: 960_000n, currency: 'TRY',
    fuel: 'GASOLINE', transmission: 'AUTOMATIC', city: 'İstanbul', imageUrl: null, bodyType: 'Sedan', color: 'Beyaz',
    sellerType: null, damageInfo: null, ...over,
  };
  return { ...base, contentHash: contentHash(base) };
}

const t = (n: number) => new Date(Date.UTC(2026, 9, 11, 10, n));

describe('IngestService.ingest', () => {
  it('creates a NEW listing with first price history and an analyze job', async () => {
    const l = listing();
    const r = await ingest.ingest(sourceId, l, t(0));
    expect(r.outcome).toBe('NEW');
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: r.listingId }, include: { priceHistory: true } });
    expect(row).toMatchObject({ status: 'ACTIVE', price: 960_000n, firstSeenAt: t(0), lastSeenAt: t(0), contentHash: l.contentHash });
    expect(row.priceHistory).toHaveLength(1);
    const job = await ref.get(QueueRegistry).analyze.getJob(analyzeJobId(r.listingId, 'NEW', l.contentHash));
    expect(job?.data).toEqual({ listingId: r.listingId, reason: 'NEW' });
    expect(job?.opts.removeOnComplete).toBe(true);
  });

  it('handles concurrent ingests of the same new listing without duplicates', async () => {
    const l = listing();
    const [a, b] = await Promise.all([ingest.ingest(sourceId, l, t(0)), ingest.ingest(sourceId, l, t(0))]);
    expect([a.outcome, b.outcome].sort()).toEqual(['NEW', 'UNCHANGED']);
    expect(a.listingId).toBe(b.listingId);
    expect(await prisma.listing.count()).toBe(1);
    expect(await prisma.listingPriceHistory.count()).toBe(1);
  });

  it('is idempotent: the same listing twice (e.g. pagination shift) is UNCHANGED and adds no history', async () => {
    const l = listing();
    const first = await ingest.ingest(sourceId, l, t(0));
    const second = await ingest.ingest(sourceId, l, t(1));
    expect(second).toEqual({ outcome: 'UNCHANGED', listingId: first.listingId });
    expect(await prisma.listing.count()).toBe(1);
    expect(await prisma.listingPriceHistory.count()).toBe(1);
    expect(await ref.get(QueueRegistry).analyze.count()).toBe(1);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: first.listingId } })).lastSeenAt).toEqual(t(1));
  });

  it('records a PRICE_CHANGED with history and previousPrice in the analyze job', async () => {
    const { listingId } = await ingest.ingest(sourceId, listing(), t(0));
    const cheaper = listing({ price: 900_000n });
    const r = await ingest.ingest(sourceId, cheaper, t(5));
    expect(r.outcome).toBe('PRICE_CHANGED');
    const history = await prisma.listingPriceHistory.findMany({ where: { listingId }, orderBy: { observedAt: 'asc' } });
    expect(history.map((h) => h.price)).toEqual([960_000n, 900_000n]);
    const job = await ref.get(QueueRegistry).analyze.getJob(analyzeJobId(listingId, 'PRICE_CHANGE', cheaper.contentHash));
    expect(job?.data).toEqual({ listingId, reason: 'PRICE_CHANGE', previousPrice: '960000' });
  });

  it('records km changes in history but non-price edits as UPDATED without history', async () => {
    const { listingId } = await ingest.ingest(sourceId, listing(), t(0));
    expect((await ingest.ingest(sourceId, listing({ title: 'Yeni başlık' }), t(1))).outcome).toBe('UPDATED');
    expect(await prisma.listingPriceHistory.count({ where: { listingId } })).toBe(1);
    expect((await ingest.ingest(sourceId, listing({ title: 'Yeni başlık', km: 86_000 }), t(2))).outcome).toBe('UPDATED');
    expect(await prisma.listingPriceHistory.count({ where: { listingId } })).toBe(2);
  });

  it('marks unseen listings REMOVED and brings them back as RELISTED', async () => {
    const a = await ingest.ingest(sourceId, listing(), t(0));
    await ingest.ingest(sourceId, listing({ externalId: 'D000002', url: 'http://demo/ilan/D000002' }), t(10));
    expect(await ingest.markRemoved(sourceId, t(10))).toBe(1);
    const removed = await prisma.listing.findUniqueOrThrow({ where: { id: a.listingId } });
    expect(removed.status).toBe('REMOVED');
    expect(removed.removedAt).not.toBeNull();
    const back = await ingest.ingest(sourceId, listing(), t(20));
    expect(back.outcome).toBe('RELISTED');
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: a.listingId } })).toMatchObject({ status: 'ACTIVE', removedAt: null, relistedAt: t(20) });
    const job = await ref.get(QueueRegistry).analyze.getJob(analyzeJobId(a.listingId, 'RELIST', listing().contentHash));
    expect(job?.data.reason).toBe('RELIST');
  });

  it('keeps listings of different sources apart', async () => {
    const other = await prisma.dataSource.create({ data: { code: 'other', name: 'Other', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST' } });
    await ingest.ingest(sourceId, listing(), t(0));
    expect((await ingest.ingest(other.id, listing(), t(0))).outcome).toBe('NEW');
    expect(await ingest.markRemoved(other.id, t(5))).toBe(1);
    expect(await prisma.listing.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });
});

describe('IngestService.recordProblems', () => {
  it('stores problems as ListingIssue rows with bounded lengths', async () => {
    await ingest.recordProblems(sourceId, [
      { externalId: 'X1', field: 'price', problem: 'p'.repeat(800), rawSnippet: 's'.repeat(2000) },
      { field: 'externalId', problem: 'boş' },
    ]);
    const rows = await prisma.listingIssue.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sourceId, externalId: 'X1', field: 'price' });
    expect(rows[0].problem.length).toBe(500);
    expect(rows[0].rawSnippet?.length).toBe(1000);
    expect(rows[1].externalId).toBeNull();
  });
});

describe('AliasService', () => {
  it('resolves from the seeded alias table and caches', async () => {
    const aliases = ref.get(AliasService);
    const resolve = await aliases.resolver();
    expect(resolve('BMW 3 Serisi 320i')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '320i' });
    await prisma.makeModelAlias.create({ data: { rawText: 'Tesla Model 3', make: 'Tesla', model: 'Model 3' } });
    expect((await aliases.resolver())('Tesla Model 3')).toBeNull();
    aliases.invalidate();
    expect((await aliases.resolver())('Tesla Model 3')).toMatchObject({ make: 'Tesla' });
  });
});
