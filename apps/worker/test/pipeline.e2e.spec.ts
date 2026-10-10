import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { seedDemoSource } from '@oto/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { analyzeJobId } from '../src/collection/ingest.service';
import { PrismaService } from '../src/infra/prisma.service';
import { SCRAPE_WORKER_AUTOSTART, ScrapeWorkerHost } from '../src/processors/scrape-worker.host';
import { QueueRegistry } from '../src/queues/queue-registry';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { createAdmin, createContext, resetState, startDemo } from './helpers';

@Module({
  imports: [CollectionModule],
  providers: [ScrapeWorkerHost, { provide: SCRAPE_WORKER_AUTOSTART, useValue: false }],
  exports: [ScrapeWorkerHost],
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
  await ref.get(ScrapeWorkerHost).onModuleDestroy();
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
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
    expect(await analyze.count()).toBe(60);

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
});
