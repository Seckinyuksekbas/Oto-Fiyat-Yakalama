import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { seedDemoSource } from '@oto/db';
import { CATALOG, fairPrice } from '@oto/demo-site';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { CollectionModule } from '../src/collection/collection.module';
import { analyzeJobId } from '../src/collection/ingest.service';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { ANALYZE_WORKER_AUTOSTART, AnalyzeWorkerHost } from '../src/processors/analyze-worker.host';
import { MATCH_WORKER_AUTOSTART, MatchWorkerHost } from '../src/processors/match-worker.host';
import { SCRAPE_WORKER_AUTOSTART, ScrapeWorkerHost } from '../src/processors/scrape-worker.host';
import { QueueRegistry } from '../src/queues/queue-registry';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { createAdmin, createContext, createProfile, createUser, resetState, startDemo } from './helpers';

@Module({
  imports: [CollectionModule, AnalysisModule, MatchingModule],
  providers: [
    ScrapeWorkerHost,
    { provide: SCRAPE_WORKER_AUTOSTART, useValue: false },
    AnalyzeWorkerHost,
    { provide: ANALYZE_WORKER_AUTOSTART, useValue: false },
    MatchWorkerHost,
    { provide: MATCH_WORKER_AUTOSTART, useValue: false },
  ],
  exports: [ScrapeWorkerHost, AnalyzeWorkerHost, MatchWorkerHost],
})
class ProcessorTestModule {}

let ref: TestingModule;
let prisma: PrismaService;
let scheduler: SchedulerService;
let demo: Awaited<ReturnType<typeof startDemo>>;

beforeAll(async () => {
  ref = await createContext([CollectionModule, SchedulerModule, ProcessorTestModule]);
  prisma = ref.get(PrismaService);
  scheduler = ref.get(SchedulerService);
  demo = await startDemo({ size: 60 });
  ref.get(ScrapeWorkerHost).start();
});
afterAll(async () => {
  await ref.get(MatchWorkerHost).onModuleDestroy();
  await ref.get(AnalyzeWorkerHost).onModuleDestroy();
  await ref.get(ScrapeWorkerHost).onModuleDestroy();
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  demo.site.store.reset(7, 60);
  demo.site.setMode('normal');
});

async function cycle(at: Date): Promise<void> {
  expect(await scheduler.tick(at)).toBe(1);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = await prisma.collectionJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('scrape cycle timed out');
}

describe('collection pipeline (scheduler → queue → worker → DB → analyze queue)', () => {
  it('follows the demo market through new, price drop, removal, relist and block', async () => {
    await createAdmin(ref);
    const source = await seedDemoSource(prisma, demo.baseUrl);
    await prisma.dataSource.update({ where: { id: source.id }, data: { minRequestGapMs: 0, intervalSec: 60 } });
    const t0 = new Date();
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const byExt = (externalId: string) =>
      prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId } }, include: { priceHistory: true } });
    const analyze = ref.get(QueueRegistry).analyze;

    // 1) İlk tarama: 60 ilan, her biri için NEW analiz işi
    await cycle(at(0));
    expect(await prisma.listing.count({ where: { status: 'ACTIVE' } })).toBe(60);
    // + her ilan henüz analizsiz olduğundan tarama sonrası REFRESH işi (analyze-post-*)
    const firstJobs = await analyze.getJobs(['waiting', 'prioritized', 'delayed']);
    expect(firstJobs.filter((j) => !String(j.id).startsWith('analyze-post-'))).toHaveLength(60);
    expect(firstJobs.filter((j) => String(j.id).startsWith('analyze-post-'))).toHaveLength(60);

    // 2) Fiyat düşüşü + kaldırma + fırsat ilanı
    const [drop, gone] = demo.site.store.active();
    demo.site.store.patch(drop.id, { price: drop.price - 100_000 });
    demo.site.store.patch(gone.id, { status: 'REMOVED' });
    const deal = demo.site.store.inject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: 2021, km: 40_000, discount: 0.25 });
    await cycle(at(1));
    const dropped = await byExt(drop.id);
    expect(dropped.priceHistory.map((h) => Number(h.price))).toEqual([drop.price + 100_000, drop.price]);
    expect((await analyze.getJob(analyzeJobId(dropped.id, 'PRICE_CHANGE', dropped.contentHash)))?.data.previousPrice).toBe(String(drop.price + 100_000));
    expect((await byExt(gone.id)).status).toBe('REMOVED');
    const dealRow = await byExt(deal.id);
    expect(dealRow).toMatchObject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: 2021, km: 40_000 });
    expect(await analyze.getJob(analyzeJobId(dealRow.id, 'NEW', dealRow.contentHash))).toBeTruthy();

    // 3) Geri gelen ilan
    demo.site.store.patch(gone.id, { status: 'ACTIVE' });
    await cycle(at(2));
    const back = await byExt(gone.id);
    expect(back.status).toBe('ACTIVE');
    expect(back.relistedAt).not.toBeNull();

    // 4) Kaynak engeller → duraklatılır, admin uyarılır, artık iş üretilmez
    demo.site.setMode('captcha');
    await cycle(at(3));
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('PAUSED');
    expect(await prisma.notification.count({ where: { kind: 'SYSTEM_ALERT' } })).toBe(1);
    expect(await scheduler.tick(at(10))).toBe(0);
    expect(await prisma.listing.count({ where: { status: 'ACTIVE' } })).toBe(61);
    demo.site.setMode('normal');
  });

  // Analiz worker'ı yalnızca bu testte çalışır: ilk senaryo analyze kuyruğundaki işleri sayıp inceler.
  it('analyzes scraped listings and emits a NEW match event for an injected deal', async () => {
    ref.get(AnalyzeWorkerHost).start();
    ref.get(MatchWorkerHost).start();
    await createAdmin(ref);
    const user = await createUser(ref);
    const profile = await createProfile(ref, user.id, { make: 'BMW', minDiscountPct: 0.1, minConfidence: 'LOW' });
    const source = await seedDemoSource(prisma, demo.baseUrl);
    await prisma.dataSource.update({ where: { id: source.id }, data: { minRequestGapMs: 0, intervalSec: 60 } });
    const year = new Date().getFullYear();
    const bmw = CATALOG.find((c) => c.make === 'BMW')!;
    const fair = fairPrice(bmw, year - 2, 40_000, year);
    // Fırsat ilanı ÖNCE eklenir: liste en yeniden eskiye sıralı olduğundan emsaller ondan önce ingest edilir
    // ve fırsatın analizi tam emsal havuzunu görür.
    const deal = demo.site.store.inject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: year - 2, km: 40_000, fuel: 'Benzin', transmission: 'Otomatik', discount: 0.25 });
    for (let i = 0; i < 9; i++) {
      demo.site.store.inject({ make: 'BMW', model: '3 Serisi', trim: '318i', year: year - 2, km: 40_000 + i * 500, fuel: 'Benzin', transmission: 'Otomatik', price: Math.round((fair * (0.97 + i * 0.0075)) / 1000) * 1000 });
    }
    await cycle(new Date());
    const row = await prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId: deal.id } } });
    const deadline = Date.now() + 30_000;
    let analysisId: number | null = null;
    while (Date.now() < deadline && !analysisId) {
      analysisId = (await prisma.listing.findUniqueOrThrow({ where: { id: row.id } })).latestAnalysisId;
      if (!analysisId) await new Promise((r) => setTimeout(r, 200));
    }
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: analysisId! } });
    expect(['HIGH', 'MEDIUM']).toContain(a.confidence);
    expect(Number(a.discountPct)).toBeGreaterThan(0.18);
    expect(Number(a.discountPct)).toBeLessThan(0.32);
    expect(a.opportunityScore).toBeGreaterThanOrEqual(60);
    // Eşleşme kuyrukta bekleyebilir ya da worker tarafından tüketilmiş olabilir; asıl sonuç ListingMatch'tir.
    let match = null;
    const matchDeadline = Date.now() + 30_000;
    while (Date.now() < matchDeadline && !match) {
      match = await prisma.listingMatch.findFirst({ where: { listingId: row.id, searchProfileId: profile.id } });
      if (!match) await new Promise((r) => setTimeout(r, 200));
    }
    expect(match).not.toBeNull();
    expect(match!.reason).toBe('NEW');
    expect(match!.matchedPrice).toBe(row.price);
  });
});
