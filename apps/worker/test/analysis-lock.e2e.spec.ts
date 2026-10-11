import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisSettingsService } from '../src/analysis/analysis-settings.service';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { AnalysisLockBusyError, AnalysisService } from '../src/analysis/analysis.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { ANALYZE_WORKER_AUTOSTART, AnalyzeWorkerHost } from '../src/processors/analyze-worker.host';
import { RETRYING_JOB_OPTS } from '../src/queues/job-options';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAnalysis, createContext, createListing, createSource, resetState } from './helpers';

@Module({
  imports: [AnalysisModule],
  providers: [AnalyzeWorkerHost, { provide: ANALYZE_WORKER_AUTOSTART, useValue: false }],
  exports: [AnalyzeWorkerHost],
})
class LockTestModule {}

let ref: TestingModule;
let prisma: PrismaService;
let redis: RedisService;
let service: AnalysisService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([LockTestModule]);
  prisma = ref.get(PrismaService);
  redis = ref.get(RedisService);
  service = ref.get(AnalysisService);
});
afterAll(async () => {
  await ref.get(AnalyzeWorkerHost).onModuleDestroy();
  await ref.close();
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}

describe('analysis lock', () => {
  it('releases its own lock when finished', async () => {
    const l = await createListing(ref, sourceId);
    await service.process(l.id);
    expect(await redis.get(`lock:analyze:${l.id}`)).toBeNull();
  });

  it('does not delete a lock that now belongs to someone else (CAS release)', async () => {
    const l = await createListing(ref, sourceId);
    const key = `lock:analyze:${l.id}`;
    const settings = ref.get(AnalysisSettingsService);
    const realGet = settings.get.bind(settings);
    vi.spyOn(settings, 'get').mockImplementation(async (...a) => {
      await redis.set(key, 'other-owner'); // bizim kilit süresi doldu, başkası aldı
      return realGet(...a);
    });
    await service.process(l.id);
    expect(await redis.get(key)).toBe('other-owner');
  });

  it('lost lock + concurrent writer: latestAnalysisId CAS rolls back our analysis and throws busy', async () => {
    const l = await createListing(ref, sourceId);
    const settings = ref.get(AnalysisSettingsService);
    let competitorId = 0;
    const realGet = settings.get.bind(settings);
    vi.spyOn(settings, 'get').mockImplementation(async (...a) => {
      await redis.del(`lock:analyze:${l.id}`); // kilit kayboldu
      competitorId = (await createAnalysis(ref, l.id)).id; // başka süreç yazdı ve latestAnalysisId'yi aldı
      return realGet(...a);
    });
    await expect(service.process(l.id)).rejects.toBeInstanceOf(AnalysisLockBusyError);
    expect(await prisma.listingAnalysis.count({ where: { listingId: l.id } })).toBe(1);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: l.id } })).latestAnalysisId).toBe(competitorId);
  });

  it('lock-busy job is retried (delayed), not FAILED, and completes once the lock is released', async () => {
    const l = await createListing(ref, sourceId);
    const key = `lock:analyze:${l.id}`;
    await redis.set(key, 'held-by-other', 'PX', 120_000);
    ref.get(AnalyzeWorkerHost).start();
    const queue = ref.get(QueueRegistry).analyze;
    const job = await queue.add('analyze', { listingId: l.id, reason: 'NEW' }, { jobId: `analyze-${l.id}-NEW-lock`, ...RETRYING_JOB_OPTS, removeOnComplete: false });
    await waitFor(async () => (await job.getState()) === 'delayed');
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
    expect(await prisma.listingAnalysis.count()).toBe(0);
    await redis.del(key);
    await job.promote();
    await waitFor(async () => (await job.getState()) === 'completed');
    expect(await prisma.listingAnalysis.count({ where: { listingId: l.id } })).toBe(1);
  });
});
