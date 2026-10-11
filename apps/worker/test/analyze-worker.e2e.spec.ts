import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { AnalysisService } from '../src/analysis/analysis.service';
import { PrismaService } from '../src/infra/prisma.service';
import { ANALYZE_WORKER_AUTOSTART, AnalyzeWorkerHost } from '../src/processors/analyze-worker.host';
import { RETRYING_JOB_OPTS } from '../src/queues/job-options';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createContext, createListing, createSource, resetState } from './helpers';

@Module({
  imports: [AnalysisModule],
  providers: [AnalyzeWorkerHost, { provide: ANALYZE_WORKER_AUTOSTART, useValue: false }],
  exports: [AnalyzeWorkerHost],
})
class AnalyzeTestModule {}

let ref: TestingModule;
let prisma: PrismaService;

beforeAll(async () => {
  ref = await createContext([AnalyzeTestModule]);
  prisma = ref.get(PrismaService);
});
afterAll(async () => {
  await ref.get(AnalyzeWorkerHost).onModuleDestroy();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
});

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timed out');
}

describe('AnalyzeWorkerHost', () => {
  it('consumes analyze jobs and produces analyses + match events', async () => {
    const host = ref.get(AnalyzeWorkerHost);
    host.start();
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    for (let i = 0; i < 10; i++) await createListing(ref, sourceId, { price: BigInt(1_195_000 + i * 1000) });
    const t = await createListing(ref, sourceId, { price: 900_000n });
    await ref.get(QueueRegistry).analyze.add('analyze', { listingId: t.id, reason: 'NEW' }, { jobId: `analyze-${t.id}-NEW-test`, ...RETRYING_JOB_OPTS });
    const analyzed = await waitFor(async () => (await prisma.listing.findUnique({ where: { id: t.id } }))?.latestAnalysisId);
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: analyzed } });
    expect(a.matchEvent).toBe('NEW');
    expect(await ref.get(QueueRegistry).match.getJob(`match-${a.id}`)).toBeTruthy();
  });

  it('passes a MANUAL job reason through to AnalysisService.process', async () => {
    const spy = vi.spyOn(ref.get(AnalysisService), 'process');
    ref.get(AnalyzeWorkerHost).start();
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    const t = await createListing(ref, sourceId, { price: 900_000n });
    await ref.get(AnalysisService).process(t.id);
    spy.mockClear();
    await ref.get(QueueRegistry).analyze.add('analyze', { listingId: t.id, reason: 'MANUAL' }, { jobId: `analyze-manual-${t.id}-1`, ...RETRYING_JOB_OPTS });
    await waitFor(async () => ((await prisma.listingAnalysis.count({ where: { listingId: t.id } })) >= 2 ? true : null));
    expect(spy).toHaveBeenCalledWith(t.id, expect.any(Date), 'MANUAL');
    spy.mockRestore();
  });

  it('fails malformed job data on the first attempt without crashing the worker', async () => {
    ref.get(AnalyzeWorkerHost).start();
    const queue = ref.get(QueueRegistry).analyze;
    const bad = await queue.add('analyze', { listingId: -1, reason: 'NEW' } as never, { jobId: 'bad-1', ...RETRYING_JOB_OPTS });
    await waitFor(async () => ((await bad.getState()) === 'failed' ? true : null));
    const failed = await queue.getJob('bad-1');
    expect(failed?.failedReason).toContain('Geçersiz analiz işi');
    expect(failed?.attemptsMade).toBe(1);

    // Worker hâlâ sağlam: geçerli iş tamamlanır.
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    const t = await createListing(ref, sourceId, { price: 900_000n });
    const good = await queue.add('analyze', { listingId: t.id, reason: 'NEW' }, { jobId: `analyze-${t.id}-NEW-after-bad`, ...RETRYING_JOB_OPTS, removeOnComplete: false });
    await waitFor(async () => ((await good.getState()) === 'completed' ? true : null));
  });
});
