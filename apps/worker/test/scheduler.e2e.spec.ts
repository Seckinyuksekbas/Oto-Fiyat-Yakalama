import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { PrismaService } from '../src/infra/prisma.service';
import { SCRAPE_WORKER_AUTOSTART, ScrapeWorkerHost } from '../src/processors/scrape-worker.host';
import { QueueRegistry } from '../src/queues/queue-registry';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { scrapeQueueJobId, SchedulerService } from '../src/scheduler/scheduler.service';
import { createContext, createSource, resetState, startDemo } from './helpers';

/** ScrapeWorkerHost'u test içinde elle başlatıp durdurmak için otomatik başlatma kapalı. */
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
  demo = await startDemo();
});
afterAll(async () => {
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  demo.site.store.reset(7, 45);
});

const T0 = new Date('2026-10-11T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('SchedulerService.tick', () => {
  it('enqueues a due source once and waits for its interval', async () => {
    const source = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
    expect(await scheduler.tick(T0)).toBe(1);
    const [job] = await prisma.collectionJob.findMany({ where: { sourceId: source.id } });
    expect(job).toMatchObject({ status: 'QUEUED', trigger: 'SCHEDULED' });
    expect((await ref.get(QueueRegistry).scrape.getJob(scrapeQueueJobId(job.id)))?.data).toEqual({ collectionJobId: job.id, sourceId: source.id });
    expect(await scheduler.tick(T0)).toBe(0); // hâlâ QUEUED
    await prisma.collectionJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', createdAt: T0 } });
    expect(await scheduler.tick(plus(59_000))).toBe(0);
    expect(await scheduler.tick(plus(60_000))).toBe(1);
  });

  it('ignores inactive and paused sources', async () => {
    await createSource(ref, demo.baseUrl, { isActive: false });
    await createSource(ref, demo.baseUrl, { health: 'PAUSED' });
    expect(await scheduler.tick(T0)).toBe(0);
  });

  it('recovers from a crashed worker: stale RUNNING jobs fail and the source is rescheduled (Review Focus #4)', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const stuck = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'RUNNING', createdAt: plus(-31 * 60_000) } });
    expect(await scheduler.tick(T0)).toBe(1);
    expect(await prisma.collectionJob.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: 'FAILED', errorSummary: expect.stringContaining('zaman aşımı') });
  });

  it('fails a stale QUEUED job and enqueues a new one', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const stale = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'QUEUED', createdAt: plus(-31 * 60_000) } });
    expect(await scheduler.tick(T0)).toBe(1);
    expect((await prisma.collectionJob.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('FAILED');
    expect(await prisma.collectionJob.count({ where: { sourceId: source.id, status: 'QUEUED' } })).toBe(1);
  });

  it('does not orphan a QUEUED job or abort the tick when enqueueing fails', async () => {
    const a = await createSource(ref, demo.baseUrl);
    const b = await createSource(ref, demo.baseUrl);
    const spy = vi.spyOn(ref.get(QueueRegistry).scrape, 'add').mockRejectedValueOnce(new Error('redis down'));
    try {
      expect(await scheduler.tick(T0)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const jobs = await prisma.collectionJob.findMany({ where: { sourceId: { in: [a.id, b.id] } } });
    expect(jobs).toHaveLength(2);
    const failed = jobs.filter((j) => j.status === 'FAILED');
    const queued = jobs.filter((j) => j.status === 'QUEUED');
    expect(failed).toHaveLength(1);
    expect(failed[0].errorSummary).toContain('Kuyruğa eklenemedi');
    expect(queued).toHaveLength(1);
    expect(await ref.get(QueueRegistry).scrape.getJob(scrapeQueueJobId(queued[0].id))).toBeTruthy();
  });

  it('keeps a recent RUNNING job alone', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'RUNNING', createdAt: plus(-5 * 60_000) } });
    expect(await scheduler.tick(T0)).toBe(0);
  });
});

describe('SchedulerService.cleanup', () => {
  it('deletes logs, scrape errors and listing issues older than 30 days', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const old = plus(-31 * 24 * 3600_000);
    await prisma.systemLog.createMany({ data: [{ level: 'WARN', component: 'x', message: 'old', createdAt: old }, { level: 'WARN', component: 'x', message: 'new', createdAt: plus(-24 * 3600_000) }] });
    await prisma.scrapeError.createMany({ data: [{ sourceId: source.id, kind: 'NETWORK', message: 'old', transient: true, createdAt: old }, { sourceId: source.id, kind: 'NETWORK', message: 'new', transient: true, createdAt: plus(-24 * 3600_000) }] });
    await prisma.listingIssue.createMany({ data: [{ sourceId: source.id, field: 'price', problem: 'old', createdAt: old }, { sourceId: source.id, field: 'price', problem: 'new', createdAt: plus(-24 * 3600_000) }] });
    expect(await scheduler.cleanup(T0)).toEqual({ systemLogs: 1, scrapeErrors: 1, listingIssues: 1 });
    expect(await prisma.systemLog.count()).toBe(1);
  });
});

describe('ScrapeWorkerHost', () => {
  it('processes scheduled scrape jobs from the queue end to end', async () => {
    const host = ref.get(ScrapeWorkerHost);
    host.start();
    try {
      const source = await createSource(ref, demo.baseUrl);
      await scheduler.tick(new Date());
      const deadline = Date.now() + 30_000;
      let status = 'QUEUED';
      while (Date.now() < deadline && status !== 'SUCCEEDED') {
        await new Promise((r) => setTimeout(r, 200));
        status = (await prisma.collectionJob.findFirstOrThrow({ where: { sourceId: source.id } })).status;
      }
      expect(status).toBe('SUCCEEDED');
      expect(await prisma.listing.count({ where: { sourceId: source.id } })).toBe(45);
    } finally {
      await host.onModuleDestroy();
    }
  });
});
