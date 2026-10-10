import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { createAnalysis, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let svc: MatchService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([MatchingModule]);
  prisma = ref.get(PrismaService);
  svc = ref.get(MatchService);
});
afterAll(async () => ref.close());
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function setup(price = 960_000n) {
  const l = await createListing(ref, sourceId, { price, city: 'İstanbul' });
  const a = await createAnalysis(ref, l.id);
  return { l, a };
}

describe('MatchService', () => {
  it('creates NEW matches for matching active profiles only', async () => {
    const { l, a } = await setup();
    const u1 = await createUser(ref);
    const u2 = await createUser(ref);
    const hit = await createProfile(ref, u1.id, { make: 'bmw', minDiscountPct: 0.1 });
    await createProfile(ref, u2.id, { make: 'Audi' });
    await createProfile(ref, u2.id, { status: 'PAUSED' });
    const out = await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect(out.status).toBe('MATCHED');
    expect(out.created).toEqual([expect.objectContaining({ searchProfileId: hit.id, userId: u1.id, reason: 'NEW' })]);
    const rows = await prisma.listingMatch.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ analysisId: a.id, matchedPrice: 960_000n, reason: 'NEW' });
  });

  it('is idempotent for duplicate and concurrent jobs', async () => {
    const { l, a } = await setup();
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const job = { listingId: l.id, analysisId: a.id, event: 'NEW' as const };
    await Promise.all([svc.process(job), svc.process(job), svc.process(job)]);
    await svc.process(job);
    expect(await prisma.listingMatch.count()).toBe(1);
  });

  it('price drop: notifies at threshold relative to the last matched price', async () => {
    const { l, a } = await setup(1_000_000n);
    const u = await createUser(ref);
    await createProfile(ref, u.id, { priceDropPct: 0.05 });
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    await prisma.listing.update({ where: { id: l.id }, data: { price: 960_000n } });
    const small = await createAnalysis(ref, l.id, { listingPrice: 960_000n });
    expect((await svc.process({ listingId: l.id, analysisId: small.id, event: 'PRICE_DROP', previousPrice: '1000000' })).created).toEqual([]);
    const big = await createAnalysis(ref, l.id, { listingPrice: 940_000n });
    const out = await svc.process({ listingId: l.id, analysisId: big.id, event: 'PRICE_DROP', previousPrice: '960000' });
    expect(out.created.map((c) => c.reason)).toEqual(['PRICE_DROP']);
  });

  it('out-of-order: PRICE_DROP before NEW yields a single NEW', async () => {
    const { l, a: first } = await setup(1_000_000n);
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const second = await createAnalysis(ref, l.id, { listingPrice: 900_000n });
    await svc.process({ listingId: l.id, analysisId: second.id, event: 'PRICE_DROP', previousPrice: '1000000' });
    await svc.process({ listingId: l.id, analysisId: first.id, event: 'NEW' });
    const rows = await prisma.listingMatch.findMany();
    expect(rows.map((r) => [r.reason, r.matchedPrice])).toEqual([['NEW', 900_000n]]);
  });

  it('relist reaches RELIST profiles; never-matched profiles get NEW', async () => {
    const { l, a } = await setup();
    const u = await createUser(ref);
    const relister = await createProfile(ref, u.id, { notifyOnRelist: true, notifyOnPriceDrop: false });
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    const late = await createProfile(ref, u.id, { notifyOnRelist: false });
    const ra = await createAnalysis(ref, l.id);
    const out = await svc.process({ listingId: l.id, analysisId: ra.id, event: 'RELIST' });
    expect(out.created.map((c) => [c.searchProfileId, c.reason]).sort()).toEqual([[late.id, 'NEW'], [relister.id, 'RELIST']].sort());
  });

  it('uses analysis flags for damage and skips removed listings / unknown analyses', async () => {
    const { l, a } = await setup();
    await prisma.listingAnalysis.update({ where: { id: a.id }, data: { flags: ['DAMAGED'] } });
    const u = await createUser(ref);
    await createProfile(ref, u.id, { excludeDamaged: true });
    expect((await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).created).toEqual([]);
    await prisma.listing.update({ where: { id: l.id }, data: { status: 'REMOVED' } });
    expect(await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).toMatchObject({ status: 'SKIPPED', reason: 'LISTING_INACTIVE' });
    expect(await svc.process({ listingId: l.id, analysisId: 999_999, event: 'NEW' })).toMatchObject({ status: 'SKIPPED', reason: 'NOT_FOUND' });
  });

  it('suspended users are not matched', async () => {
    const { l, a } = await setup();
    const u = await createUser(ref, { status: 'SUSPENDED' });
    await createProfile(ref, u.id);
    expect((await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).created).toEqual([]);
  });
});
