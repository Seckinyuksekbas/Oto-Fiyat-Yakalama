import type { TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchDispatcher } from '../src/analysis/match-dispatcher.service';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { PrismaService } from '../src/infra/prisma.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { AnalysisSweepService, istanbulDayKey, istanbulHour } from '../src/scheduler/analysis-sweep.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { createContext, createListing, createSource, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let sweep: AnalysisSweepService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([AnalysisModule, SchedulerModule]);
  prisma = ref.get(PrismaService);
  sweep = ref.get(AnalysisSweepService);
});
afterAll(async () => {
  await ref.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

describe('Istanbul time helpers', () => {
  it('derive the local day and hour (UTC+3)', () => {
    expect(istanbulDayKey(new Date('2026-10-11T20:59:00Z'))).toBe('20261011');
    expect(istanbulDayKey(new Date('2026-10-11T21:00:00Z'))).toBe('20261012');
    expect(istanbulHour(new Date('2026-10-11T23:30:00Z'))).toBe(2);
    expect(istanbulHour(new Date('2026-10-12T00:00:00Z'))).toBe(3);
  });
});

describe('AnalysisSweepService.maybeRunNightly', () => {
  it('runs once per Istanbul day after 03:00 and only for ACTIVE listings', async () => {
    const a = await createListing(ref, sourceId);
    await createListing(ref, sourceId, { status: 'REMOVED' });
    const b = await createListing(ref, sourceId);
    expect(await sweep.maybeRunNightly(new Date('2026-10-11T23:30:00Z'))).toBe(0); // 02:30 İstanbul
    expect(await sweep.maybeRunNightly(new Date('2026-10-12T00:10:00Z'))).toBe(2); // 03:10
    expect(await sweep.maybeRunNightly(new Date('2026-10-12T05:00:00Z'))).toBe(0); // aynı gün
    const jobs = await ref.get(QueueRegistry).analyze.getJobs(['waiting', 'prioritized']);
    expect(jobs.map((j) => j.id).sort()).toEqual([`analyze-refresh-${a.id}-20261012`, `analyze-refresh-${b.id}-20261012`].sort());
    expect(jobs.every((j) => j.data.reason === 'REFRESH' && j.opts.priority === 100)).toBe(true);
    expect(await sweep.maybeRunNightly(new Date('2026-10-13T00:10:00Z'))).toBe(2); // ertesi gün
  });

  it('releases the day marker when enqueueing fails so the next tick retries', async () => {
    await createListing(ref, sourceId);
    const spy = vi.spyOn(sweep, 'enqueueRefreshAll').mockRejectedValueOnce(new Error('redis down'));
    const at = new Date('2026-10-12T00:10:00Z');
    await expect(sweep.maybeRunNightly(at)).rejects.toThrow('redis down');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await sweep.maybeRunNightly(new Date('2026-10-12T00:11:00Z'))).toBe(1);
  });

  it('enqueueRefreshAll dedupes per day and covers listings with and without latestAnalysisId', async () => {
    const withAnalysis = await createListing(ref, sourceId);
    const without = await createListing(ref, sourceId);
    const analysis = await prisma.listingAnalysis.create({
      data: { listingId: withAnalysis.id, engineVersion: 'rules-v1', opportunityScore: 50, comparableCount: 5, confidence: 'MEDIUM', explanation: {}, comparableIds: [] },
    });
    await prisma.listing.update({ where: { id: withAnalysis.id }, data: { latestAnalysisId: analysis.id } });
    const q = ref.get(QueueRegistry).analyze;
    expect(await sweep.enqueueRefreshAll('20261012')).toBe(2);
    expect(await q.count()).toBe(2);
    expect(await q.getJob(`analyze-refresh-${withAnalysis.id}-20261012`)).toBeTruthy();
    expect(await q.getJob(`analyze-refresh-${without.id}-20261012`)).toBeTruthy();
    await sweep.enqueueRefreshAll('20261012');
    expect(await q.count()).toBe(2);
  });

  it('pages through large listing sets', async () => {
    const data = Array.from({ length: 1203 }, (_, i) => ({
      sourceId, externalId: `B${i}`, url: `http://x/${i}`, title: `B${i}`, make: 'BMW', model: '3 Serisi', year: 2019, km: 1, fuel: 'GASOLINE' as const, transmission: 'AUTOMATIC' as const, price: 100_000n, contentHash: `b${i}`,
    }));
    await prisma.listing.createMany({ data });
    expect(await sweep.enqueueRefreshAll('20261012')).toBe(1203);
    expect(await ref.get(QueueRegistry).analyze.count()).toBe(1203);
  });
});

describe('AnalysisSweepService.requeuePendingMatches', () => {
  it('re-dispatches match events older than 60 s that were never queued', async () => {
    const l = await createListing(ref, sourceId);
    const base = { listingId: l.id, engineVersion: 'rules-v1', opportunityScore: 50, comparableCount: 5, confidence: 'MEDIUM' as const, explanation: {}, comparableIds: [] };
    const now = new Date('2026-10-12T10:00:00Z');
    const pending = await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'PRICE_DROP', matchPreviousPrice: 1_000_000n, createdAt: new Date(now.getTime() - 120_000) } });
    await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'NEW', createdAt: new Date(now.getTime() - 10_000) } }); // çok yeni
    await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'NEW', matchQueuedAt: now, createdAt: new Date(now.getTime() - 120_000) } }); // zaten kuyrukta
    await prisma.listingAnalysis.create({ data: { ...base, createdAt: new Date(now.getTime() - 120_000) } }); // olay yok
    expect(await sweep.requeuePendingMatches(now)).toBe(1);
    const job = await ref.get(QueueRegistry).match.getJob(`match-${pending.id}`);
    expect(job?.data).toEqual({ listingId: l.id, analysisId: pending.id, event: 'PRICE_DROP', previousPrice: '1000000' });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: pending.id } })).matchQueuedAt).not.toBeNull();
    expect(await sweep.requeuePendingMatches(now)).toBe(0);
  });

  it('continues past a dispatch failure and leaves the failed one unqueued', async () => {
    const l = await createListing(ref, sourceId);
    const base = { listingId: l.id, engineVersion: 'rules-v1', opportunityScore: 50, comparableCount: 5, confidence: 'MEDIUM' as const, explanation: {}, comparableIds: [] };
    const now = new Date('2026-10-12T10:00:00Z');
    const old = new Date(now.getTime() - 120_000);
    const first = await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'NEW', createdAt: old } });
    const second = await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'NEW', createdAt: old } });
    const dispatcher = ref.get(MatchDispatcher);
    vi.spyOn(dispatcher, 'dispatch').mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    expect(await sweep.requeuePendingMatches(now)).toBe(1);
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: first.id } })).matchQueuedAt).toBeNull();
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: second.id } })).matchQueuedAt).not.toBeNull();
    vi.restoreAllMocks();
    expect(await sweep.requeuePendingMatches(now)).toBe(1);
  });
});
