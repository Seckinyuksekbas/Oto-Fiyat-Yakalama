import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, seedListing, verifyEmail } from './helpers';

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

const ids = (res: { body: { items: { id: number }[] } }) => res.body.items.map((i) => i.id);

type Page = { body: { items: { id: number }[]; nextCursor: string | null } };

describe('GET /me/opportunities', () => {
  it('returns ACTIVE listings with score>=60 and confidence>=MEDIUM, best score first, as cards', async () => {
    const A = await registerUser(app);
    const a = await seedListing(app, {
      analysis: {
        opportunityScore: 77,
        confidence: 'HIGH',
        explanation: { stats: { q1: 1_100_000.4, median: 1_200_000.6, q3: 1_300_000 }, insufficientReason: 'NONE' },
      },
    });
    const b = await seedListing(app, { analysis: { opportunityScore: 65, confidence: 'MEDIUM' } });
    await seedListing(app, { analysis: { opportunityScore: 90, confidence: 'LOW' } });
    await seedListing(app, { analysis: { opportunityScore: 50, confidence: 'HIGH' } });
    await seedListing(app, { listing: { status: 'REMOVED' }, analysis: { opportunityScore: 95 } });
    const res = await A.agent.get('/api/v1/me/opportunities');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([a.listingId, b.listingId]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items[0]).toMatchObject({
      price: '960000',
      isFavorite: false,
      status: 'ACTIVE',
      analysis: {
        opportunityScore: 77,
        confidence: 'HIGH',
        estimatedPrice: '1200000',
        discountPct: 0.2,
        band: { q1: '1100000', median: '1200001', q3: '1300000' },
        insufficientReason: 'NONE',
      },
    });
    expect(typeof res.body.items[0].firstSeenAt).toBe('string');
  });

  it('filters (make case-insensitive via fold, city, maxPrice, minScore, confidence) and sorts recent/discount', async () => {
    const A = await registerUser(app);
    const now = Date.now();
    const x = await seedListing(app, {
      listing: { make: 'BMW', city: 'İstanbul', price: 900_000n, firstSeenAt: new Date(now - 3_000_000) },
      analysis: { opportunityScore: 70, confidence: 'MEDIUM', discountPct: 0.1 },
    });
    const y = await seedListing(app, {
      listing: { make: 'Audi', model: 'A4', city: 'Ankara', price: 800_000n, firstSeenAt: new Date(now - 2_000_000) },
      analysis: { opportunityScore: 90, confidence: 'HIGH', discountPct: 0.3 },
    });
    const z = await seedListing(app, {
      listing: { make: 'BMW', city: 'İzmir', price: 1_000_000n, firstSeenAt: new Date(now - 1_000_000) },
      analysis: { opportunityScore: 80, confidence: 'HIGH', discountPct: null },
    });
    const get = async (qs: string) => ids(await A.agent.get(`/api/v1/me/opportunities?${qs}`));
    expect(await get('make=bmw')).toEqual([z.listingId, x.listingId]);
    expect(await get('make=BMW&model=3%20serisi')).toEqual([z.listingId, x.listingId]);
    expect(await get(`city=${encodeURIComponent('izmir')}`)).toEqual([z.listingId]);
    expect(await get(`city=${encodeURIComponent('İstanbul')}`)).toEqual([x.listingId]);
    expect(await get('maxPrice=900000')).toEqual([y.listingId, x.listingId]);
    expect(await get('minScore=80')).toEqual([y.listingId, z.listingId]);
    expect(await get('confidence=HIGH')).toEqual([y.listingId, z.listingId]);
    expect(await get('sort=recent')).toEqual([z.listingId, y.listingId, x.listingId]);
    expect(await get('sort=discount')).toEqual([y.listingId, x.listingId, z.listingId]);
    expect((await A.agent.get('/api/v1/me/opportunities?minScore=10')).status).toBe(400);
  });

  it('paginates with an opaque cursor without duplicates or gaps across equal scores', async () => {
    const A = await registerUser(app);
    const created: number[] = [];
    for (let i = 0; i < 5; i += 1) created.push((await seedListing(app, { analysis: { opportunityScore: 70 } })).listingId);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Page = await A.agent.get(`/api/v1/me/opportunities?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.items.map((i) => i.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...created].sort((p, q) => q - p));
    const bad = await A.agent.get('/api/v1/me/opportunities?cursor=AAAA');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    // cursor from a different sort is rejected, not misapplied
    const scoreCursor = (await A.agent.get('/api/v1/me/opportunities?limit=2')).body.nextCursor as string;
    expect((await A.agent.get(`/api/v1/me/opportunities?sort=recent&cursor=${scoreCursor}`)).status).toBe(400);
  });

  it('paginates discount (NULL last) and recent sorts with ties and no gaps', async () => {
    const A = await registerUser(app);
    const t = new Date(Date.now() - 5_000_000);
    const all: number[] = [];
    for (const d of [0.3, 0.3, null, 0.1, null]) {
      all.push((await seedListing(app, { listing: { firstSeenAt: t }, analysis: { discountPct: d, opportunityScore: 70 } })).listingId);
    }
    for (const sort of ['discount', 'recent', 'score']) {
      const seen: number[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const res: Page & { status: number } = await A.agent.get(
          `/api/v1/me/opportunities?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(res.status).toBe(200);
        seen.push(...res.body.items.map((i) => i.id));
        cursor = res.body.nextCursor;
        guard += 1;
      } while (cursor && guard < 10);
      expect(seen.length, sort).toBe(5);
      expect(new Set(seen).size, sort).toBe(5);
    }
    const first = await A.agent.get('/api/v1/me/opportunities?sort=discount&limit=5');
    expect(ids(first)).toEqual([all[1], all[0], all[3], all[4], all[2]]);
  });

  it('respects opportunitiesDelayHours from the user plan', async () => {
    const A = await registerUser(app);
    await app
      .get(PrismaService)
      .userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { opportunitiesDelayHours: 2 } } });
    await seedListing(app);
    const old = await seedListing(app, { listing: { firstSeenAt: new Date(Date.now() - 3 * 3_600_000) } });
    expect(ids(await A.agent.get('/api/v1/me/opportunities'))).toEqual([old.listingId]);
  });

  it('marks favorites', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    await app.get(PrismaService).favorite.create({ data: { userId: A.user.id, listingId: l.listingId } });
    const res = await A.agent.get('/api/v1/me/opportunities');
    expect(res.body.items[0].isFavorite).toBe(true);
  });
});

describe('GET /me/listings/:id', () => {
  it('returns detail with band, price history, comparables joined to listings, and my matches only', async () => {
    const A = await registerUser(app);
    const B = await registerUser(app);
    await verifyEmail(app, A.user.id);
    await verifyEmail(app, B.user.id);
    const c1 = await seedListing(app, { listing: { title: 'Emsal 1', city: 'Ankara' } });
    const c2 = await seedListing(app, { listing: { title: 'Emsal 2' } });
    const target = await seedListing(app, {
      analysis: {
        explanation: {
          insufficientReason: 'NONE',
          stats: { q1: 1_100_000, median: 1_200_000, q3: 1_300_000, dispersion: 0.1 },
          comparables: [
            { id: c1.listingId, price: 1_150_000, year: 2019, km: 80_000, damaged: false, adjusted: 1_150_000.4, clamped: false, outlier: true },
            { id: c2.listingId, price: 1_250_000, year: 2020, km: 60_000, damaged: true, adjusted: 1_240_000.6, clamped: true, outlier: false },
            { id: 999_999, price: 1, year: 2019, km: 1, damaged: false, adjusted: 1, clamped: false, outlier: false },
          ],
        },
      },
    });
    const prisma = app.get(PrismaService);
    const t0 = Date.now();
    await prisma.listingPriceHistory.createMany({
      data: [
        { listingId: target.listingId, price: 960_000n, km: 85_000, observedAt: new Date(t0 - 1_000_000) },
        { listingId: target.listingId, price: 1_000_000n, km: 85_000, observedAt: new Date(t0 - 2_000_000) },
      ],
    });
    const pa = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'pa' })).body.id;
    const pb = (await B.agent.post('/api/v1/me/search-profiles').send({ name: 'pb' })).body.id;
    await prisma.listingMatch.create({
      data: { userId: A.user.id, searchProfileId: pa, listingId: target.listingId, analysisId: target.analysisId, reason: 'NEW', matchedPrice: 960_000n },
    });
    await prisma.listingMatch.create({
      data: { userId: B.user.id, searchProfileId: pb, listingId: target.listingId, analysisId: target.analysisId, reason: 'NEW', matchedPrice: 960_000n },
    });

    const res = await A.agent.get(`/api/v1/me/listings/${target.listingId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: target.listingId,
      price: '960000',
      isFavorite: false,
      analysis: { band: { q1: '1100000', median: '1200000', q3: '1300000' } },
    });
    expect(res.body.priceHistory.map((p: { price: string }) => p.price)).toEqual(['1000000', '960000']);
    expect(res.body.comparables).toHaveLength(2);
    // outlier olmayanlar önce
    expect(res.body.comparables[0]).toMatchObject({
      id: c2.listingId, title: 'Emsal 2', adjusted: '1240001', damaged: true, clamped: true, outlier: false, status: 'ACTIVE', price: '1250000',
    });
    expect(res.body.comparables[1]).toMatchObject({ id: c1.listingId, title: 'Emsal 1', city: 'Ankara', adjusted: '1150000', outlier: true });
    expect(res.body.myMatches).toHaveLength(1);
    expect(res.body.myMatches[0]).toMatchObject({ reason: 'NEW', matchedPrice: '960000', profile: { id: pa, name: 'pa' } });
    expect(res.body.explanation).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(pb);
  });

  it('REMOVED listing is still readable with status REMOVED; unknown/invalid id → 404', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app, { listing: { status: 'REMOVED', removedAt: new Date() } });
    const res = await A.agent.get(`/api/v1/me/listings/${l.listingId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REMOVED');
    expect(res.body.removedAt).toEqual(expect.any(String));
    for (const id of ['999999', '0', '-1', 'abc', '2147483648', '1.5']) {
      const r = await A.agent.get(`/api/v1/me/listings/${id}`);
      expect(r.status, id).toBe(404);
    }
  });

  it('listing without analysis returns analysis null and explanation null', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    await app.get(PrismaService).listing.update({ where: { id: l.listingId }, data: { latestAnalysisId: null } });
    const res = await A.agent.get(`/api/v1/me/listings/${l.listingId}`);
    expect(res.status).toBe(200);
    expect(res.body.analysis).toBeNull();
    expect(res.body.explanation).toBeNull();
    expect(res.body.comparables).toEqual([]);
  });
});
