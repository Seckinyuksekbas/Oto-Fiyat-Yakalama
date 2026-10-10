import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { IngestService } from '../src/collection/ingest.service';
import { ScrapeRunner } from '../src/collection/scrape-runner.service';
import { PrismaService } from '../src/infra/prisma.service';
import { createAdmin, createContext, createQueuedJob, createSource, resetState, startDemo } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let runner: ScrapeRunner;
let demo: Awaited<ReturnType<typeof startDemo>>;

beforeAll(async () => {
  ref = await createContext([CollectionModule]);
  prisma = ref.get(PrismaService);
  runner = ref.get(ScrapeRunner);
  demo = await startDemo();
});
afterAll(async () => {
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  demo.site.store.reset(7, 45);
  demo.site.setMode('normal');
});

async function runOnce(sourceId: number) {
  const job = await createQueuedJob(ref, sourceId);
  await runner.run(job.id);
  return prisma.collectionJob.findUniqueOrThrow({ where: { id: job.id } });
}

describe('ScrapeRunner', () => {
  it('crawls every page and ingests all listings on the first run', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', pagesFetched: 3, listingsSeen: 45, listingsNew: 45, listingsUpdated: 0, listingsRemoved: 0, errorsCount: 0 });
    expect(job.startedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect(job.avgResponseMs).not.toBeNull();
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
  });

  it('tracks price changes, removals and new listings on the next run', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    const [cheap, gone] = demo.site.store.active();
    demo.site.store.patch(cheap.id, { price: cheap.price - 50_000 });
    demo.site.store.patch(gone.id, { status: 'REMOVED' });
    const fresh = demo.site.store.inject({ discount: 0.25 });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', listingsNew: 1, listingsUpdated: 1, listingsRemoved: 1 });
    const byExt = async (externalId: string) => prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId } }, include: { priceHistory: true } });
    expect((await byExt(cheap.id)).priceHistory).toHaveLength(2);
    expect((await byExt(gone.id)).status).toBe('REMOVED');
    expect((await byExt(fresh.id)).status).toBe('ACTIVE');
  });

  it('never removes listings or ingests garbage when the layout breaks (Review Focus #1)', async () => {
    await createAdmin(ref);
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    demo.site.setMode('broken');
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'PARTIAL', listingsSeen: 45, listingsNew: 0, listingsRemoved: 0, errorsCount: 45 });
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    expect(await prisma.listingIssue.count({ where: { sourceId: source.id } })).toBe(45);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('DEGRADED');
    expect(await prisma.systemLog.count({ where: { level: 'WARN' } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: 'SYSTEM_ALERT' } })).toBe(1);
  });

  it.each(['captcha', 'forbidden'] as const)('pauses the source when blocked (%s) and alerts admins', async (mode) => {
    await createAdmin(ref);
    const source = await createSource(ref, demo.baseUrl);
    demo.site.setMode(mode);
    const job = await runOnce(source.id);
    expect(job.status).toBe('FAILED');
    expect(await prisma.scrapeError.findFirst({ where: { jobId: job.id } })).toMatchObject({ kind: 'BLOCKED', transient: false });
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('PAUSED');
    expect(await prisma.systemLog.count({ where: { level: 'ERROR' } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: 'SYSTEM_ALERT' } })).toBe(1);
  });

  it('counts consecutive network failures and degrades after 3', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    for (let i = 0; i < 2; i++) expect((await runOnce(source.id)).status).toBe('FAILED');
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 2 });
    await runOnce(source.id);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'DEGRADED', consecutiveFailures: 3 });
    expect(await prisma.scrapeError.findFirst()).toMatchObject({ kind: 'NETWORK', transient: true });
  });

  it('does not remove anything after an incomplete crawl (maxPages)', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    await prisma.dataSource.update({ where: { id: source.id }, data: { config: { baseUrl: demo.baseUrl, maxPages: 1 } } });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', pagesFetched: 1, listingsRemoved: 0 });
    expect(job.errorSummary).toContain('Tarama sayfa sınırında durdu; kaldırma tespiti atlandı');
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
  });

  it('does not remove anything when fullCrawl is false', async () => {
    const source = await createSource(ref, demo.baseUrl, { config: { baseUrl: demo.baseUrl, fullCrawl: false } });
    await runOnce(source.id);
    const [gone] = demo.site.store.active();
    demo.site.store.patch(gone.id, { status: 'REMOVED' });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', listingsRemoved: 0 });
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
  });

  it('does not remove anything after a fatal error on page 2 (PARTIAL)', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    const flaky: Server = createServer((req, res) => (req.url?.includes('sayfa=2') ? res.writeHead(500).end() : demo.site.app(req, res)));
    await new Promise<void>((done) => flaky.listen(0, '127.0.0.1', done));
    try {
      const baseUrl = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
      await prisma.dataSource.update({ where: { id: source.id }, data: { config: { baseUrl } } });
      const [gone] = demo.site.store.active();
      demo.site.store.patch(gone.id, { status: 'REMOVED' });
      const job = await runOnce(source.id);
      expect(job).toMatchObject({ status: 'PARTIAL', pagesFetched: 1, listingsRemoved: 0 });
      expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    } finally {
      flaky.closeAllConnections();
      await new Promise<void>((done) => flaky.close(() => done()));
    }
  });

  it('skips mass removal and alerts, but still removes a single disappearance', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    const items = demo.site.store.active();
    for (const it of items.slice(0, 30)) demo.site.store.patch(it.id, { status: 'REMOVED' });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', listingsRemoved: 0 });
    expect(job.errorSummary).toContain('toplu kaldırma');
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    expect(await prisma.systemLog.count({ where: { level: 'WARN', message: { contains: 'toplu kaldırma' } } })).toBe(1);
    for (const it of items.slice(0, 30)) demo.site.store.patch(it.id, { status: 'ACTIVE' });
    await runOnce(source.id);
    demo.site.store.patch(items[0].id, { status: 'REMOVED' });
    const small = await runOnce(source.id);
    expect(small).toMatchObject({ listingsRemoved: 1 });
  });

  it('degrades the source after ONE run when the page layout is unrecognisable', async () => {
    await createAdmin(ref);
    const bakim = createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>bakım</body></html>'));
    await new Promise<void>((done) => bakim.listen(0, '127.0.0.1', done));
    try {
      const source = await createSource(ref, `http://127.0.0.1:${(bakim.address() as AddressInfo).port}`);
      const job = await runOnce(source.id);
      expect(job.status).toBe('FAILED');
      expect(await prisma.scrapeError.findFirst({ where: { jobId: job.id } })).toMatchObject({ kind: 'PARSE', transient: false });
      expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('DEGRADED');
      expect(await prisma.systemLog.count({ where: { level: 'WARN' } })).toBe(1);
      const keys = (await prisma.notification.findMany({ where: { kind: 'SYSTEM_ALERT' } })).map((n) => (n.payload as { key: string }).key);
      expect(keys).toEqual([`source:${source.id}:parse`]);
    } finally {
      bakim.closeAllConnections();
      await new Promise<void>((done) => bakim.close(() => done()));
    }
  });

  it('refuses dry-run jobs before touching the network', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const queued = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', dryRun: true } });
    expect(await runner.run(queued.id)).toBeNull();
    const job = await prisma.collectionJob.findUniqueOrThrow({ where: { id: queued.id } });
    expect(job).toMatchObject({ status: 'FAILED', errorSummary: 'Dry-run henüz desteklenmiyor (Plan 07)', pagesFetched: 0 });
    expect(await prisma.listing.count()).toBe(0);
  });

  it('does not overwrite a job that was closed (reaped) while the crawl was running', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const ingest = ref.get(IngestService);
    const original = ingest.ingest.bind(ingest);
    const spy = vi.spyOn(ingest, 'ingest').mockImplementationOnce(async (...args) => {
      await prisma.collectionJob.updateMany({ where: { sourceId: source.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date(), errorSummary: 'reaped' } });
      return original(...args);
    });
    try {
      const queued = await createQueuedJob(ref, source.id);
      await runner.run(queued.id);
      expect(await prisma.collectionJob.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'FAILED', errorSummary: 'reaped' });
    } finally {
      spy.mockRestore();
    }
  });

  it('skips jobs that are not QUEUED and fails jobs of paused sources', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const done = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'SUCCEEDED' } });
    expect(await runner.run(done.id)).toBeNull();
    expect(await runner.run(999_999)).toBeNull();
    await prisma.dataSource.update({ where: { id: source.id }, data: { health: 'PAUSED' } });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'FAILED', pagesFetched: 0 });
    expect(await prisma.listing.count()).toBe(0);
    const unknown = await createSource(ref, demo.baseUrl, { adapterKey: 'nope' });
    const failed = await runOnce(unknown.id);
    expect(failed).toMatchObject({ status: 'FAILED', errorSummary: expect.stringContaining('Bilinmeyen adapter') });
  });

  it('a recovered source becomes HEALTHY again', async () => {
    const source = await createSource(ref, demo.baseUrl, { health: 'DEGRADED', consecutiveFailures: 4 });
    await runOnce(source.id);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
  });
});

describe('ScrapeRunner robustness', () => {
  it('fails the job cleanly when setup throws, without blaming the source', async () => {
    const proxy = await prisma.proxyConfig.create({ data: { name: 'bad', urlEncrypted: 'v1:bad', isEnabled: true } });
    const source = await createSource(ref, demo.baseUrl, { proxyConfigId: proxy.id });
    const job = await runOnce(source.id);
    expect(job.status).toBe('FAILED');
    expect(job.finishedAt).not.toBeNull();
    expect(job.errorSummary).toContain('Kurulum hatası');
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
    expect(await prisma.scrapeError.count()).toBe(0);
  });

  it('does not remove seen-but-invalid listings', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    const [victim] = demo.site.store.active();
    demo.site.store.patch(victim.id, { price: 10_000 });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'PARTIAL', errorsCount: 1, listingsRemoved: 0 });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId: victim.id } } });
    expect(listing.status).toBe('ACTIVE');
    expect(await prisma.listingIssue.count({ where: { sourceId: source.id, externalId: victim.id } })).toBeGreaterThan(0);
  });

  it('treats infrastructure errors as job failures, not source failures', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const spy = vi.spyOn(ref.get(IngestService), 'ingest').mockRejectedValueOnce(new Error('db down'));
    try {
      const queued = await createQueuedJob(ref, source.id);
      await expect(runner.run(queued.id)).rejects.toThrow('db down');
      const job = await prisma.collectionJob.findUniqueOrThrow({ where: { id: queued.id } });
      expect(job.status).toBe('FAILED');
      expect(job.errorSummary).toContain('Altyapı hatası');
      expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
      expect(await prisma.scrapeError.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('zero cards is not a success', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    demo.site.store.reset(7, 0);
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'PARTIAL', listingsRemoved: 0, errorSummary: 'Sayfada ilan kartı bulunamadı' });
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('DEGRADED');
  });

  it('goes DEGRADED then DOWN with one alert each', async () => {
    await createAdmin(ref);
    const source = await createSource(ref, 'http://127.0.0.1:1');
    for (let i = 0; i < 6; i++) await runOnce(source.id);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'DOWN', consecutiveFailures: 6 });
    const keys = (await prisma.notification.findMany({ where: { kind: 'SYSTEM_ALERT' } })).map((n) => (n.payload as { key: string }).key).sort();
    expect(keys).toEqual([`source:${source.id}:degraded`, `source:${source.id}:down`]);
    expect(await prisma.systemLog.count({ where: { level: 'ERROR' } })).toBe(1);
  });
});
