import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { ANALYSIS_SETTINGS_KEY, AnalysisSettingsService } from '../src/analysis/analysis-settings.service';
import { AnalysisLockBusyError, AnalysisService } from '../src/analysis/analysis.service';
import { PrismaService } from '../src/infra/prisma.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createContext, createListing, createSource, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let service: AnalysisService;
let sourceId: number;

const MARKET = [1_110_000, 1_120_000, 1_130_000, 1_140_000, 1_150_000, 1_170_000, 1_190_000, 1_210_000, 1_230_000, 1_250_000, 1_260_000, 1_270_000, 1_280_000, 1_290_000];

beforeAll(async () => {
  ref = await createContext([AnalysisModule]);
  prisma = ref.get(PrismaService);
  service = ref.get(AnalysisService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  ref.get(AnalysisSettingsService).invalidate();
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function seedMarket(over: Record<string, unknown> = {}) {
  for (const p of MARKET) await createListing(ref, sourceId, { price: BigInt(p), ...over });
}
const matchJobs = () => ref.get(QueueRegistry).match.getJobs(['waiting', 'delayed']);

describe('AnalysisService.process', () => {
  it('analyzes a NEW listing, stores the analyzed state and emits a NEW match event', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { trim: '320i', price: 960_000n });
    const out = await service.process(t.id);
    expect(out).toMatchObject({ status: 'WRITTEN', event: 'NEW' });
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect(a).toMatchObject({ estimatedPrice: 1_200_000n, confidence: 'HIGH', opportunityScore: 77, listingPrice: 960_000n, listingContentHash: t.contentHash, matchEvent: 'NEW', comparableCount: 14 });
    expect(Number(a.discountPct)).toBe(0.2);
    expect(a.matchQueuedAt).not.toBeNull();
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: t.id } })).latestAnalysisId).toBe(a.id);
    const [job] = await matchJobs();
    expect(job.id).toBe(`match-${a.id}`);
    expect(job.data).toEqual({ listingId: t.id, analysisId: a.id, event: 'NEW' });
  });

  it('a nightly refresh without content or market change writes nothing and emits nothing', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    await service.process(t.id);
    const again = await service.process(t.id);
    expect(again).toMatchObject({ status: 'UNCHANGED', event: 'REFRESH' });
    expect(await prisma.listingAnalysis.count()).toBe(1);
    expect(await matchJobs()).toHaveLength(1);
  });

  it('a refresh after the market moved > 2% writes a new row but emits no match event', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    await service.process(t.id);
    await prisma.listing.updateMany({ where: { id: { not: t.id } }, data: { price: { increment: 100_000n } } });
    const out = await service.process(t.id);
    expect(out).toMatchObject({ status: 'WRITTEN', event: 'REFRESH' });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } })).matchEvent).toBeNull();
    expect(await matchJobs()).toHaveLength(1);
  });

  it('two price drops before analysis collapse into one PRICE_DROP vs the last analyzed price (Review Focus #5)', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 1_100_000n });
    await service.process(t.id);
    await prisma.listing.update({ where: { id: t.id }, data: { price: 1_050_000n, contentHash: 'c2' } });
    await prisma.listing.update({ where: { id: t.id }, data: { price: 980_000n, contentHash: 'c3' } });
    const out = await service.process(t.id);
    expect(out.event).toBe('PRICE_DROP');
    const job = (await matchJobs()).find((j) => j.data.analysisId === out.analysisId);
    expect(job?.data).toMatchObject({ event: 'PRICE_DROP', previousPrice: '1100000' });
  });

  it('a price increase is a CHANGE: new analysis, no match event', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 1_000_000n });
    await service.process(t.id);
    await prisma.listing.update({ where: { id: t.id }, data: { price: 1_050_000n, contentHash: 'up' } });
    expect(await service.process(t.id)).toMatchObject({ status: 'WRITTEN', event: 'CHANGE' });
    expect(await matchJobs()).toHaveLength(1);
  });

  it('a relisted listing emits RELIST even when its content is unchanged', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 1_000_000n });
    await service.process(t.id);
    await prisma.listing.update({ where: { id: t.id }, data: { relistedAt: new Date(Date.now() + 1000) } });
    expect(await service.process(t.id)).toMatchObject({ status: 'WRITTEN', event: 'RELIST' });
  });

  it('skips REMOVED and unknown listings', async () => {
    const t = await createListing(ref, sourceId, { status: 'REMOVED' });
    expect(await service.process(t.id)).toEqual({ status: 'SKIPPED', event: null, analysisId: null });
    expect(await service.process(999_999)).toEqual({ status: 'SKIPPED', event: null, analysisId: null });
  });

  it('builds the comparable pool from the 60-day window, same fuel/transmission, recent removals only', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 61 * 24 * 3600_000);
    await seedMarket();
    await createListing(ref, sourceId, { price: 10_000_000n, lastSeenAt: old });
    await createListing(ref, sourceId, { price: 10_000_000n, fuel: 'DIESEL' });
    await createListing(ref, sourceId, { price: 10_000_000n, status: 'REMOVED', removedAt: old, lastSeenAt: now });
    await createListing(ref, sourceId, { price: 1_200_000n, status: 'REMOVED', removedAt: now });
    const t = await createListing(ref, sourceId, { price: 960_000n });
    const out = await service.process(t.id, now);
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect((a.explanation as { pool: { candidates: number } }).pool.candidates).toBe(15);
  });

  it('uses price history for the drop bonus and damageInfo for flags', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n, damageInfo: { tramerAmount: 15000, paintedParts: [], changedParts: [] } });
    await prisma.listingPriceHistory.createMany({ data: [{ listingId: t.id, price: 1_000_000n, km: 85_000, observedAt: new Date(Date.now() - 2000) }, { listingId: t.id, price: 960_000n, km: 85_000 }] });
    const out = await service.process(t.id);
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect(a.flags).toContain('DAMAGED');
    expect(a.confidence).toBe('MEDIUM');
    expect(a.opportunityScore).toBe(Math.round((0.2 / 0.3) * 70) + 18 + 5);
  });

  it('serializes concurrent analyses of the same listing (Review Focus #4)', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    const results = await Promise.allSettled([service.process(t.id), service.process(t.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AnalysisLockBusyError);
    expect(await prisma.listingAnalysis.count()).toBe(1);
  });

  it('applies valid settings overrides and ignores invalid ones', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    await prisma.systemSetting.create({ data: { key: ANALYSIS_SETTINGS_KEY, value: { minComparables: 20 } } });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: (await service.process(t.id)).analysisId! } })).confidence).toBe('INSUFFICIENT');
    await prisma.systemSetting.update({ where: { key: ANALYSIS_SETTINGS_KEY }, data: { value: { minComparables: 'many' } } });
    ref.get(AnalysisSettingsService).invalidate();
    await prisma.listing.update({ where: { id: t.id }, data: { price: 950_000n, contentHash: 'x' } });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: (await service.process(t.id)).analysisId! } })).confidence).toBe('HIGH');
  });

  it('keeps the analysis even when the match queue is unavailable (requeued later)', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    const spy = vi.spyOn(ref.get(QueueRegistry).match, 'add').mockRejectedValueOnce(new Error('redis down'));
    const out = await service.process(t.id);
    spy.mockRestore();
    expect(out.status).toBe('WRITTEN');
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect(a).toMatchObject({ matchEvent: 'NEW', matchQueuedAt: null });
  });
});
