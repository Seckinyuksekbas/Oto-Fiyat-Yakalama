import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
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

  it('rejects malformed job data without crashing the worker', async () => {
    ref.get(AnalyzeWorkerHost).start();
    const job = await ref.get(QueueRegistry).analyze.add('analyze', { listingId: -1, reason: 'NEW' } as never, { jobId: 'bad-1', attempts: 1 });
    await waitFor(async () => ((await job.getState()) === 'failed' ? true : null));
  });
});
