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

  it('a dry-run does not reset the interval clock, but an in-flight dry-run blocks a new scheduled job', async () => {
    const source = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
    await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'SUCCEEDED', createdAt: T0 } });
    const dry = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'MANUAL', dryRun: true, status: 'SUCCEEDED', createdAt: plus(50_000) } });
    // son dry-run 10 sn önce olsa da saat son GERÇEK işten (T0) hesaplanır
    expect(await scheduler.tick(plus(60_000))).toBe(1);
    await prisma.collectionJob.updateMany({ where: { sourceId: source.id }, data: { status: 'SUCCEEDED' } });
    await prisma.collectionJob.update({ where: { id: dry.id }, data: { status: 'RUNNING' } });
    expect(await scheduler.tick(plus(200_000))).toBe(0);
  });

  it('ignores inactive and paused sources', async () => {
    await createSource(ref, demo.baseUrl, { isActive: false });
    await createSource(ref, demo.baseUrl, { health: 'PAUSED' });
    expect(await scheduler.tick(T0)).toBe(0);
  });

  it.each([
    ['deactivated', { isActive: false }],
    ['paused', { health: 'PAUSED' as const }],
  ])('re-reads eligibility under the row lock: a source %s after the candidate list was read gets no job (Plan 07 test borcu)', async (_label, change) => {
    const source = await createSource(ref, demo.baseUrl);
    let candidateReads = 0;
    // Aday listesi okunduktan hemen sonra (satır kilidi alınmadan önce) admin kaynağı değiştirir.
    // Prisma delegeleri vi.spyOn ile geri yüklenemediğinden ayrı bir SchedulerService'e sarmalanmış istemci verilir.
    const racing = new Proxy(prisma, {
      get(target, key) {
        if (key === 'dataSource') {
          return {
            findMany: async (args: Parameters<typeof prisma.dataSource.findMany>[0]) => {
              const rows = await target.dataSource.findMany(args);
              candidateReads += 1;
              await target.dataSource.update({ where: { id: source.id }, data: change });
              return rows;
            },
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const racingScheduler = new SchedulerService(racing, ref.get(QueueRegistry));
    expect(await racingScheduler.tick(T0)).toBe(0);
    expect(candidateReads).toBe(1);
    expect(await prisma.collectionJob.count({ where: { sourceId: source.id } })).toBe(0);
    expect(await ref.get(QueueRegistry).scrape.count()).toBe(0);
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

  describe('orphaned QUEUED jobs (no BullMQ job) are recovered', () => {
    const ORPHAN_AGE = 2 * 60_000;

    it('a tx that commits but reports "transaction already closed" does not abort the tick; the next tick past 2 min re-enqueues it', async () => {
      const source = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
      const other = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
      let failed = false;
      // İlk kaynağın tx'i commit olur ama Prisma "already closed" fırlatır (yük altında görülen durum): kuyruğa eklenmez.
      const flaky = new Proxy(prisma, {
        get(target, key) {
          if (key === '$transaction') {
            return async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
              const result = await (target.$transaction as (f: typeof fn, o?: unknown) => Promise<unknown>)(
                fn,
                opts,
              );
              if (!failed) {
                failed = true;
                throw new Error(
                  'Transaction already closed: A commit cannot be executed on an expired transaction.',
                );
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const flakyScheduler = new SchedulerService(flaky, ref.get(QueueRegistry));
      expect(await flakyScheduler.tick(T0)).toBe(1); // diğer kaynak yine de kuyruğa girer
      const [orphan] = await prisma.collectionJob.findMany({ where: { sourceId: source.id } });
      expect(orphan).toMatchObject({ status: 'QUEUED' });
      expect(await ref.get(QueueRegistry).scrape.getJob(scrapeQueueJobId(orphan.id))).toBeUndefined();
      expect(await prisma.collectionJob.count({ where: { sourceId: other.id, status: 'QUEUED' } })).toBe(1);

      // 2 dk dolmadan dokunulmaz (API/scheduler henüz kuyruğa ekliyor olabilir)
      await scheduler.tick(plus(ORPHAN_AGE - 1000));
      expect(await ref.get(QueueRegistry).scrape.getJob(scrapeQueueJobId(orphan.id))).toBeUndefined();

      await scheduler.tick(plus(ORPHAN_AGE + 1000));
      const requeued = await ref.get(QueueRegistry).scrape.getJob(scrapeQueueJobId(orphan.id));
      expect(requeued?.data).toEqual({ collectionJobId: orphan.id, sourceId: source.id });
      expect(await prisma.collectionJob.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
        status: 'QUEUED',
      });

      // idempotent: tekrar eden tick yeni iş/satır üretmez
      await scheduler.tick(plus(ORPHAN_AGE + 5000));
      expect(
        await ref.get(QueueRegistry).scrape.getJobCountByTypes('waiting', 'delayed', 'active', 'prioritized'),
      ).toBe(2);
      expect(await prisma.collectionJob.count({ where: { sourceId: source.id } })).toBe(1);
    });

    it('marks the orphan FAILED ("Kuyruğa eklenemedi") when re-enqueueing fails, so the source is free again', async () => {
      const source = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
      const orphan = await prisma.collectionJob.create({
        data: { sourceId: source.id, trigger: 'SCHEDULED', createdAt: T0 },
      });
      const spy = vi
        .spyOn(ref.get(QueueRegistry).scrape, 'add')
        .mockRejectedValueOnce(new Error('redis down'));
      let enqueued = 0;
      try {
        // Aynı tick'te yetim FAILED olur ve kaynak serbest kalınca yeni zamanlanmış iş üretilir (mockRejectedValueOnce)
        enqueued = await scheduler.tick(plus(ORPHAN_AGE + 1000));
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.collectionJob.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
        status: 'FAILED',
        errorSummary: expect.stringContaining('Kuyruğa eklenemedi'),
      });
      expect(enqueued).toBe(1);
      expect(await prisma.collectionJob.count({ where: { sourceId: source.id, status: 'QUEUED' } })).toBe(1);
    });

    it('leaves a QUEUED job that has its BullMQ job alone', async () => {
      const source = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
      expect(await scheduler.tick(T0)).toBe(1);
      const add = vi.spyOn(ref.get(QueueRegistry).scrape, 'add');
      try {
        await scheduler.tick(plus(ORPHAN_AGE + 1000));
        expect(add).not.toHaveBeenCalled();
      } finally {
        add.mockRestore();
      }
      expect(await prisma.collectionJob.count({ where: { sourceId: source.id, status: 'QUEUED' } })).toBe(1);
    });
  });

  it('keeps a recent RUNNING job alone', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'RUNNING', createdAt: plus(-5 * 60_000) } });
    expect(await scheduler.tick(T0)).toBe(0);
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
