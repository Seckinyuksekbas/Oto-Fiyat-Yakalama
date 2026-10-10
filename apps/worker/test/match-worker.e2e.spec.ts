import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MATCH_WORKER_AUTOSTART, MatchWorkerHost } from '../src/processors/match-worker.host';
import { RETRYING_JOB_OPTS } from '../src/queues/job-options';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAnalysis, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

@Module({
  imports: [MatchingModule],
  providers: [MatchWorkerHost, { provide: MATCH_WORKER_AUTOSTART, useValue: false }],
  exports: [MatchWorkerHost],
})
class MatchTestModule {}

let ref: TestingModule;

beforeAll(async () => {
  ref = await createContext([MatchTestModule]);
  ref.get(MatchWorkerHost).start();
});
afterAll(async () => {
  await ref.get(MatchWorkerHost).onModuleDestroy();
  await ref.close();
});
beforeEach(async () => resetState(ref));

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timed out');
}

describe('MatchWorkerHost', () => {
  it('consumes match jobs into ListingMatch rows', async () => {
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    const l = await createListing(ref, sourceId);
    const a = await createAnalysis(ref, l.id);
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    await ref.get(QueueRegistry).match.add('match', { listingId: l.id, analysisId: a.id, event: 'NEW' }, { jobId: `match-${a.id}`, ...RETRYING_JOB_OPTS });
    const m = await waitFor(() => ref.get(PrismaService).listingMatch.findFirst({ where: { listingId: l.id } }));
    expect(m.reason).toBe('NEW');
  });

  it('fails malformed payloads on the first attempt and keeps consuming', async () => {
    const queue = ref.get(QueueRegistry).match;
    const bad = await queue.add('match', { listingId: 1, analysisId: 0, event: 'NEW' } as never, { jobId: 'bad-match-1', ...RETRYING_JOB_OPTS });
    await waitFor(async () => ((await bad.getState()) === 'failed' ? true : null));
    const failed = await queue.getJob('bad-match-1');
    expect(failed?.failedReason).toContain('Geçersiz eşleştirme işi');
    expect(failed?.attemptsMade).toBe(1);
  });
});
