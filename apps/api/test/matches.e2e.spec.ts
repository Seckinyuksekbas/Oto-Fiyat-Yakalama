import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, resetState, seedListing, seedMatch, verifyEmail } from './helpers';

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('POST /me/search-profiles/preview', () => {
  it('returns matching listings newest first with money as strings and a daily estimate', async () => {
    const A = await registerUser(app);
    const hit = await seedListing(app);
    await seedListing(app, { listing: { make: 'Audi', model: 'A4' } });
    await seedListing(app, { analysis: { confidence: 'INSUFFICIENT', discountPct: 0.4 } });
    const res = await A.agent.post('/api/v1/me/search-profiles/preview').send({ make: 'bmw', minDiscountPct: 0.1 });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([hit.listingId]);
    expect(res.body.items[0]).toMatchObject({ price: '960000', analysis: { confidence: 'HIGH', discountPct: 0.2, estimatedPrice: '1200000' } });
    expect(res.body.estimatedDailyMatches).toBe(0.1);
  });

  it('validates the filter', async () => {
    const A = await registerUser(app);
    expect((await A.agent.post('/api/v1/me/search-profiles/preview').send({ name: 'x' })).status).toBe(400);
  });
});

describe('GET /me/matches', () => {
  it('lists own matches with filters and cursor pagination', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    const p1 = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'p1' })).body.id;
    const p2 = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'p2' })).body.id;
    const m1 = await seedMatch(app, A.user.id, p1, { analysis: { opportunityScore: 40, confidence: 'LOW' } });
    const m2 = await seedMatch(app, A.user.id, p1, { reason: 'PRICE_DROP' });
    const m3 = await seedMatch(app, A.user.id, p2);

    const all = await A.agent.get('/api/v1/me/matches');
    expect(all.body.items.map((m: { id: number }) => m.id)).toEqual([m3, m2, m1]);
    expect(all.body.items[0]).toMatchObject({ matchedPrice: '960000', profile: { id: p2, name: 'p2' }, listing: { price: '960000' } });
    expect(all.body.nextCursor).toBeNull();

    const page1 = await A.agent.get('/api/v1/me/matches?limit=2');
    expect(page1.body.items.map((m: { id: number }) => m.id)).toEqual([m3, m2]);
    const page2 = await A.agent.get(`/api/v1/me/matches?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((m: { id: number }) => m.id)).toEqual([m1]);

    expect((await A.agent.get(`/api/v1/me/matches?profileId=${p1}`)).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/v1/me/matches?reason=PRICE_DROP')).body.items.map((m: { id: number }) => m.id)).toEqual([m2]);
    expect((await A.agent.get('/api/v1/me/matches?minScore=60')).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/v1/me/matches?confidence=MEDIUM')).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/v1/me/matches?limit=500')).status).toBe(400);
  });
});
