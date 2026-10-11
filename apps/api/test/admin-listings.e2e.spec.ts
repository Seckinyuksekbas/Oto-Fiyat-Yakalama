import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminQueues } from '../src/infra/admin-queues.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { createTestApp, registerUser, resetState, seedListing, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
type Agent = Awaited<ReturnType<typeof registerUser>>['agent'];
let admin: Agent;
let adminId: string;

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
  await app.get(AdminQueues).analyze.obliterate({ force: true });
  const a = await registerUser(app);
  await setRole(app, a.user.id, 'ADMIN');
  admin = a.agent;
  adminId = a.user.id;
});

const api = (p: string) => `/api/v1/admin${p}`;

describe('GET /admin/listings', () => {
  it('lists cards with source code, latest analysis summary and issue count; paginates with total', async () => {
    const { listingId } = await seedListing(app, { listing: { make: 'BMW' } });
    for (let i = 0; i < 2; i += 1) await seedListing(app, { listing: { make: 'Audi' } });
    const src = await prisma.dataSource.findUniqueOrThrow({ where: { code: 'test-src' } });
    await prisma.listingIssue.createMany({
      data: [
        { sourceId: src.id, listingId, field: 'km', problem: 'negatif' },
        { sourceId: src.id, listingId, field: 'price', problem: 'sıfır' },
      ],
    });

    const res = await admin.get(api('/listings')).query({ pageSize: 2 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(2);

    const all = await admin.get(api('/listings'));
    const bmw = all.body.items.find((i: { id: number }) => i.id === listingId);
    expect(bmw).toMatchObject({
      sourceCode: 'test-src',
      sourceId: src.id,
      issueCount: 2,
      price: '960000',
      analysis: expect.objectContaining({ opportunityScore: 77, confidence: 'HIGH' }),
    });
    expect(all.body.items.filter((i: { issueCount: number }) => i.issueCount === 0)).toHaveLength(2);

    const page2 = await admin.get(api('/listings')).query({ pageSize: 2, page: 2 });
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.total).toBe(3);
  });

  it('filters by hasIssues, status, source and case-insensitive make; q escapes LIKE wildcards', async () => {
    const a = await seedListing(app, { listing: { make: 'BMW', title: 'Temiz 50% ilan' } });
    await seedListing(app, { listing: { make: 'Audi', status: 'REMOVED', title: 'Temiz 500 ilan' } });
    const src = await prisma.dataSource.findUniqueOrThrow({ where: { code: 'test-src' } });
    const other = await prisma.dataSource.create({ data: { code: 'other', name: 'O', adapterKey: 'demo', kind: 'HTTP', permissionType: 'TEST' } });
    await prisma.listing.create({
      data: {
        sourceId: other.id, externalId: 'Z1', url: 'http://demo/z', title: 'Z', make: 'Fiat', model: 'Egea', year: 2020, km: 1,
        fuel: 'DIESEL', transmission: 'MANUAL', price: 500_000n, contentHash: 'z',
      },
    });
    await prisma.listingIssue.create({ data: { sourceId: src.id, listingId: a.listingId, field: 'km', problem: 'x' } });

    const q = async (query: Record<string, string>) => (await admin.get(api('/listings')).query(query)).body;
    expect((await q({ hasIssues: 'true' })).items.map((i: { id: number }) => i.id)).toEqual([a.listingId]);
    expect((await q({ hasIssues: 'false' })).total).toBe(2);
    expect((await q({ status: 'REMOVED' })).total).toBe(1);
    expect((await q({ source: String(other.id) })).total).toBe(1);
    expect((await q({ make: 'bmw' })).total).toBe(1);
    expect((await q({ make: 'BM' })).total).toBe(0);
    expect((await q({ q: '50%' })).total).toBe(1);
    expect((await q({ q: 'temiz' })).total).toBe(2);
  });

  it('validates the query', async () => {
    expect((await admin.get(api('/listings')).query({ pageSize: 101 })).status).toBe(400);
    expect((await admin.get(api('/listings')).query({ hasIssues: 'maybe' })).status).toBe(400);
    expect((await admin.get(api('/listings')).query({ bogus: '1' })).status).toBe(400);
  });
});

describe('GET /admin/listings/:id', () => {
  it('returns detail with analysis history (newest 50, no explanation), price history, issues and match count', async () => {
    const { listingId } = await seedListing(app, { analysis: { explanation: { secretish: 'x', stats: { median: 1_200_000 } } } });
    for (let i = 0; i < 54; i += 1) {
      await prisma.listingAnalysis.create({
        data: {
          listingId, engineVersion: 'rules-v1', opportunityScore: i % 100, comparableCount: 3, confidence: 'LOW',
          flags: [], explanation: { big: 'blob' }, comparableIds: [], createdAt: new Date(Date.now() + (i + 1) * 1000),
        },
      });
    }
    await prisma.listingPriceHistory.createMany({
      data: [{ listingId, price: 1_000_000n, km: 85_000 }, { listingId, price: 960_000n, km: 85_000 }],
    });
    const src = await prisma.dataSource.findUniqueOrThrow({ where: { code: 'test-src' } });
    await prisma.listingIssue.create({ data: { sourceId: src.id, listingId, field: 'km', problem: 'garip', rawSnippet: 'abc' } });

    const res = await admin.get(api(`/listings/${listingId}`));
    expect(res.status).toBe(200);
    expect(res.body.listing).toMatchObject({ id: listingId, make: 'BMW', price: '960000', sourceCode: 'test-src', matchCount: 0 });
    expect(res.body.analyses).toHaveLength(50);
    expect(res.body.analyses[0].createdAt >= res.body.analyses[49].createdAt).toBe(true);
    expect(res.body.analyses[0]).toEqual(expect.objectContaining({ id: expect.any(Number), engineVersion: 'rules-v1', opportunityScore: expect.any(Number) }));
    expect(JSON.stringify(res.body.analyses)).not.toContain('blob');
    expect(res.body.analyses[0]).not.toHaveProperty('explanation');
    expect(res.body.priceHistory).toHaveLength(2);
    expect(res.body.issues).toEqual([expect.objectContaining({ field: 'km', problem: 'garip' })]);
  });

  it('counts matches and 404s for unknown / invalid ids', async () => {
    const { listingId, analysisId } = await seedListing(app);
    const u = await registerUser(app);
    const profile = await prisma.searchProfile.create({ data: { userId: u.user.id, name: 'p' } });
    await prisma.listingMatch.create({
      data: { userId: u.user.id, searchProfileId: profile.id, listingId, analysisId, reason: 'NEW', matchedPrice: 960_000n },
    });
    expect((await admin.get(api(`/listings/${listingId}`))).body.listing.matchCount).toBe(1);
    expect((await admin.get(api('/listings/99999'))).status).toBe(404);
    expect((await admin.get(api('/listings/abc'))).status).toBe(400);
  });
});

describe('GET /admin/listing-issues', () => {
  it('lists issues with source code, filters by source/field and paginates', async () => {
    const { listingId } = await seedListing(app);
    const src = await prisma.dataSource.findUniqueOrThrow({ where: { code: 'test-src' } });
    const other = await prisma.dataSource.create({ data: { code: 'other', name: 'O', adapterKey: 'demo', kind: 'HTTP', permissionType: 'TEST' } });
    await prisma.listingIssue.createMany({
      data: [
        { sourceId: src.id, listingId, field: 'km', problem: 'a' },
        { sourceId: src.id, field: 'price', problem: 'b', externalId: 'X' },
        { sourceId: other.id, field: 'km', problem: 'c' },
      ],
    });
    const all = await admin.get(api('/listing-issues'));
    expect(all.body.total).toBe(3);
    expect(all.body.items[0]).toEqual(expect.objectContaining({ sourceCode: expect.any(String), field: expect.any(String), problem: expect.any(String) }));
    expect((await admin.get(api('/listing-issues')).query({ source: src.id })).body.total).toBe(2);
    expect((await admin.get(api('/listing-issues')).query({ field: 'km' })).body.total).toBe(2);
    expect((await admin.get(api('/listing-issues')).query({ pageSize: 1, page: 3 })).body.items).toHaveLength(1);
  });
});

describe('GET /admin/analyses', () => {
  it('filters by confidence, minScore and engineVersion; list omits explanation, detail includes it', async () => {
    const a = await seedListing(app, { analysis: { opportunityScore: 90, confidence: 'HIGH', explanation: { why: 'because' } } });
    await seedListing(app, { analysis: { opportunityScore: 40, confidence: 'LOW', engineVersion: 'rules-v2' } });

    const all = await admin.get(api('/analyses'));
    expect(all.body.total).toBe(2);
    expect(all.body.items[0]).not.toHaveProperty('explanation');
    expect(all.body.items[0]).toEqual(expect.objectContaining({ listingId: expect.any(Number), make: 'BMW', engineVersion: expect.any(String) }));

    expect((await admin.get(api('/analyses')).query({ confidence: 'LOW' })).body.total).toBe(1);
    expect((await admin.get(api('/analyses')).query({ minScore: 80 })).body.items.map((i: { id: number }) => i.id)).toEqual([a.analysisId]);
    expect((await admin.get(api('/analyses')).query({ engineVersion: 'rules-v2' })).body.total).toBe(1);
    expect((await admin.get(api('/analyses')).query({ confidence: 'NOPE' })).status).toBe(400);

    const one = await admin.get(api(`/analyses/${a.analysisId}`));
    expect(one.status).toBe(200);
    expect(one.body.analysis).toMatchObject({ id: a.analysisId, listingId: a.listingId, explanation: { why: 'because' }, comparableIds: [] });
    expect((await admin.get(api('/analyses/99999'))).status).toBe(404);
  });
});

describe('POST /admin/listings/:id/reanalyze', () => {
  it('enqueues a MANUAL analyze job, returns 202 { jobId } and writes exactly one audit row', async () => {
    const { listingId } = await seedListing(app);
    const res = await admin.post(api(`/listings/${listingId}/reanalyze`)).send({});
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(new RegExp(`^analyze-manual-${listingId}-\\d+$`));

    const job = await app.get(AdminQueues).analyze.getJob(res.body.jobId);
    expect(job?.data).toEqual({ listingId, reason: 'MANUAL' });

    const logs = await prisma.auditLog.findMany({ where: { action: 'listing.reanalyze' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorId: adminId, targetType: 'Listing', targetId: String(listingId), after: { jobId: res.body.jobId } });
  });

  it('double click within 60s returns the same jobId, one job and one audit row; TTL is set', async () => {
    const { listingId } = await seedListing(app);
    const [r1, r2] = await Promise.all([
      admin.post(api(`/listings/${listingId}/reanalyze`)).send({}),
      admin.post(api(`/listings/${listingId}/reanalyze`)).send({}),
    ]);
    const r3 = await admin.post(api(`/listings/${listingId}/reanalyze`)).send({});
    expect([r1.status, r2.status, r3.status]).toEqual([202, 202, 202]);
    expect(new Set([r1.body.jobId, r2.body.jobId, r3.body.jobId]).size).toBe(1);
    expect(await app.get(AdminQueues).analyze.getJobCounts('waiting', 'delayed', 'active')).toMatchObject({ waiting: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'listing.reanalyze' } })).toBe(1);
    const ttl = await app.get(RedisService).ttl(`admin:reanalyze:${listingId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('a different listing is independent', async () => {
    const a = await seedListing(app);
    const b = await seedListing(app);
    const r1 = await admin.post(api(`/listings/${a.listingId}/reanalyze`)).send({});
    const r2 = await admin.post(api(`/listings/${b.listingId}/reanalyze`)).send({});
    expect(r1.body.jobId).not.toBe(r2.body.jobId);
  });

  it('404 for unknown listing, 409 for REMOVED, no job and no audit', async () => {
    expect((await admin.post(api('/listings/99999/reanalyze')).send({})).status).toBe(404);
    const { listingId } = await seedListing(app, { listing: { status: 'REMOVED' } });
    expect((await admin.post(api(`/listings/${listingId}/reanalyze`)).send({})).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'listing.reanalyze' } })).toBe(0);
    expect(await app.get(AdminQueues).analyze.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
  });

  it('queue failure returns 503, releases the dedupe key and leaves no audit row', async () => {
    const { listingId } = await seedListing(app);
    const spy = vi.spyOn(app.get(AdminQueues).analyze, 'add').mockRejectedValueOnce(new Error('redis down'));
    const res = await admin.post(api(`/listings/${listingId}/reanalyze`)).send({});
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await prisma.auditLog.count({ where: { action: 'listing.reanalyze' } })).toBe(0);
    expect(await app.get(RedisService).exists(`admin:reanalyze:${listingId}`)).toBe(0);
    // retry works right away
    expect((await admin.post(api(`/listings/${listingId}/reanalyze`)).send({})).status).toBe(202);
  });

  it('USER is refused on every listing route', async () => {
    const u = await registerUser(app);
    const { listingId } = await seedListing(app);
    expect((await u.agent.get(api('/listings'))).status).toBe(403);
    expect((await u.agent.post(api(`/listings/${listingId}/reanalyze`)).send({})).status).toBe(403);
  });
});
