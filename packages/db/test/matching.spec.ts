import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countPreviewSince, findMatchingProfiles, previewListings, type ListingFacts, type MatchFilter } from '../src/matching';

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let sourceId: number;
let seq = 0;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = pg.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "ListingMatch","ListingAnalysis","Listing","SearchProfile","User","DataSource" RESTART IDENTITY CASCADE');
  sourceId = (await prisma.dataSource.create({ data: { code: 'src', name: 'S', adapterKey: 'demo', kind: 'HTTP', permissionType: 'TEST' } })).id;
});

const FILTER: MatchFilter = {
  make: null, model: null, yearMin: null, yearMax: null, priceMin: null, priceMax: null, kmMax: null,
  fuels: [], transmissions: [], cities: [], excludeDamaged: false, minDiscountPct: 0, minConfidence: 'MEDIUM',
};
const FACTS: ListingFacts = {
  make: 'BMW', model: '3 Serisi', year: 2019, km: 85_000, price: 960_000n, fuel: 'GASOLINE', transmission: 'AUTOMATIC',
  city: 'İstanbul', damaged: false, confidence: 'HIGH', discountPct: 0.2,
};

async function user(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  seq += 1;
  return prisma.user.create({ data: { email: `u${seq}@t.com`, passwordHash: 'x', name: 'U', status } });
}
async function profile(over: Partial<MatchFilter> & { status?: 'ACTIVE' | 'PAUSED'; userStatus?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const { status, userStatus, ...f } = over;
  const u = await user(userStatus);
  const m = { ...FILTER, ...f };
  return prisma.searchProfile.create({
    data: {
      userId: u.id, name: 'p', status: status ?? 'ACTIVE', make: m.make, model: m.model, yearMin: m.yearMin, yearMax: m.yearMax,
      priceMin: m.priceMin, priceMax: m.priceMax, kmMax: m.kmMax, fuels: m.fuels as never, transmissions: m.transmissions as never,
      cities: m.cities, excludeDamaged: m.excludeDamaged, minDiscountPct: m.minDiscountPct, minConfidence: m.minConfidence as never,
      channels: ['IN_APP'],
    },
  });
}
async function listingWithAnalysis(f: ListingFacts) {
  seq += 1;
  const l = await prisma.listing.create({
    data: {
      sourceId, externalId: `E${seq}`, url: `http://x/${seq}`, title: `İlan ${seq}`, make: f.make, model: f.model, year: f.year, km: f.km,
      fuel: f.fuel as never, transmission: f.transmission as never, city: f.city, price: f.price, contentHash: `h${seq}`,
    },
  });
  const a = await prisma.listingAnalysis.create({
    data: {
      listingId: l.id, engineVersion: 'rules-v1', estimatedPrice: 1_200_000n, discountPct: f.discountPct, opportunityScore: 77,
      comparableCount: 14, confidence: f.confidence as never, flags: f.damaged ? ['DAMAGED'] : [], explanation: {}, comparableIds: [],
      listingPrice: f.price,
    },
  });
  await prisma.listing.update({ where: { id: l.id }, data: { latestAnalysisId: a.id } });
  return l;
}

/** Her profil için iki yön aynı cevabı vermeli: profil ∈ findMatchingProfiles(ilan) ⟺ ilan ∈ previewListings(profil). */
async function expectParity(f: ListingFacts, filters: Partial<MatchFilter>[], expected: boolean[]) {
  const l = await listingWithAnalysis(f);
  const profiles = [];
  for (const over of filters) profiles.push(await profile(over));
  const forward = new Set((await findMatchingProfiles(prisma, f, l.id)).map((r) => r.id));
  for (let i = 0; i < filters.length; i++) {
    const backward = (await previewListings(prisma, { ...FILTER, ...filters[i] }, 100)).some((r) => r.id === l.id);
    expect({ i, forward: forward.has(profiles[i].id) }).toEqual({ i, forward: expected[i] });
    expect({ i, backward }).toEqual({ i, backward: expected[i] });
  }
}

describe('matching predicate', () => {
  it('basic field filters (parity)', async () => {
    await expectParity(FACTS, [
      {}, { make: 'BMW' }, { make: 'Audi' }, { make: 'BMW', model: '3 Serisi' }, { make: 'BMW', model: '5 Serisi' },
      { yearMin: 2019, yearMax: 2019 }, { yearMin: 2020 }, { yearMax: 2018 },
      { priceMin: 960_000n, priceMax: 960_000n }, { priceMax: 959_999n }, { priceMin: 960_001n },
      { kmMax: 85_000 }, { kmMax: 84_999 },
      { fuels: ['GASOLINE', 'DIESEL'] }, { fuels: ['DIESEL'] },
      { transmissions: ['AUTOMATIC'] }, { transmissions: ['MANUAL'] },
    ], [true, true, false, true, false, true, false, false, true, false, false, true, false, true, false, true, false]);
  });

  it('Turkish case folding for make, model and city (parity)', async () => {
    await expectParity({ ...FACTS, make: 'Şahin', model: 'Doğan SLX', city: 'İstanbul' }, [
      { make: 'sahin' }, { make: 'ŞAHİN', model: 'dogan slx' }, { cities: ['istanbul'] }, { cities: ['ISTANBUL'] }, { cities: ['Ankara'] },
    ], [true, true, true, true, false]);
  });

  it('city filter excludes listings without a city', async () => {
    await expectParity({ ...FACTS, city: null }, [{}, { cities: ['İstanbul'] }], [true, false]);
  });

  it('damage exclusion uses analysis flags', async () => {
    await expectParity({ ...FACTS, damaged: true }, [{}, { excludeDamaged: true }], [true, false]);
  });

  it('minDiscountPct=0 matches INSUFFICIENT; >0 requires confidence and discount', async () => {
    await expectParity({ ...FACTS, confidence: 'INSUFFICIENT', discountPct: 0.3 }, [
      { minDiscountPct: 0 }, { minDiscountPct: 0.1, minConfidence: 'LOW' },
    ], [true, false]);
    await expectParity({ ...FACTS, confidence: 'MEDIUM', discountPct: 0.15 }, [
      { minDiscountPct: 0.15, minConfidence: 'MEDIUM' }, { minDiscountPct: 0.16, minConfidence: 'LOW' }, { minDiscountPct: 0.1, minConfidence: 'HIGH' },
    ], [true, false, false]);
    await expectParity({ ...FACTS, confidence: 'HIGH', discountPct: null }, [{ minDiscountPct: 0.01, minConfidence: 'LOW' }], [false]);
  });

  it('excludes paused profiles and inactive users; returns lastMatchedPrice', async () => {
    const l = await listingWithAnalysis(FACTS);
    const paused = await profile({ status: 'PAUSED' });
    const suspended = await profile({ userStatus: 'SUSPENDED' });
    const ok = await profile();
    const a = await prisma.listingAnalysis.findFirstOrThrow({ where: { listingId: l.id } });
    await prisma.listingMatch.create({ data: { userId: ok.userId, searchProfileId: ok.id, listingId: l.id, analysisId: a.id, reason: 'NEW', matchedPrice: 1_000_000n } });
    await prisma.listingMatch.create({ data: { userId: ok.userId, searchProfileId: ok.id, listingId: l.id, analysisId: a.id, reason: 'PRICE_DROP', matchedPrice: 970_000n, createdAt: new Date(Date.now() - 86_400_000) } });
    const rows = await findMatchingProfiles(prisma, FACTS, l.id);
    expect(rows.map((r) => r.id)).toEqual([ok.id]);
    expect(rows[0].lastMatchedPrice).toBe(970_000n);
    expect(rows[0].channels).toEqual(['IN_APP']);
    expect(rows[0].name).toBe('p');
    expect([paused.id, suspended.id].some((id) => rows.some((r) => r.id === id))).toBe(false);
  });

  it('preview ignores REMOVED listings, orders newest first and counts since', async () => {
    const old = await listingWithAnalysis(FACTS);
    await prisma.listing.update({ where: { id: old.id }, data: { firstSeenAt: new Date(Date.now() - 10 * 86_400_000) } });
    const fresh = await listingWithAnalysis(FACTS);
    const removed = await listingWithAnalysis(FACTS);
    await prisma.listing.update({ where: { id: removed.id }, data: { status: 'REMOVED' } });
    const rows = await previewListings(prisma, FILTER, 10);
    expect(rows.map((r) => r.id)).toEqual([fresh.id, old.id]);
    expect(typeof rows[0].price).toBe('bigint');
    expect(await countPreviewSince(prisma, FILTER, new Date(Date.now() - 7 * 86_400_000))).toBe(1);
  });
});

describe('matching predicate (review additions)', () => {
  it('fold_tr folds Turkish letters', async () => {
    const [r] = await prisma.$queryRaw<{ f: string }[]>`SELECT fold_tr('İIıĞğÜüŞşÖöÇç') AS f`;
    expect(r.f).toBe('iiigguussoocc');
  });

  it('Turkish city folding (Çanakkale, Gümüşhane, Muğla)', async () => {
    await expectParity({ ...FACTS, city: 'Çanakkale' }, [{ cities: ['canakkale'] }, { cities: ['ÇANAKKALE'] }, { cities: ['Çanakkale'] }], [true, true, true]);
    await expectParity({ ...FACTS, city: 'Gümüşhane' }, [{ cities: ['gumushane'] }, { cities: ['GÜMÜŞHANE'] }], [true, true]);
    await expectParity({ ...FACTS, city: 'Muğla' }, [{ cities: ['MUGLA'] }, { cities: ['Mugla', 'Ankara'] }], [true, true]);
  });

  it('positive cases', async () => {
    await expectParity(FACTS, [{ excludeDamaged: true }, { cities: ['Ankara', 'istanbul'] }], [true, true]);
    await expectParity({ ...FACTS, confidence: 'INSUFFICIENT', discountPct: null }, [{ minDiscountPct: 0 }], [true]);
    await expectParity({ ...FACTS, confidence: 'LOW', discountPct: 0.2 }, [{ minDiscountPct: 0.1, minConfidence: 'LOW' }], [true]);
  });

  it('profile created without arrays gets empty-array defaults and matches', async () => {
    const l = await listingWithAnalysis(FACTS);
    const u = await user();
    const p = await prisma.searchProfile.create({ data: { userId: u.id, name: 'p', channels: ['IN_APP'] } });
    const [raw] = await prisma.$queryRaw<{ fuels: string[]; transmissions: string[]; cities: string[] }[]>`SELECT "fuels"::text[] AS fuels, "transmissions"::text[] AS transmissions, "cities" FROM "SearchProfile" WHERE "id" = ${p.id}`;
    expect(raw).toEqual({ fuels: [], transmissions: [], cities: [] });
    const rows = await findMatchingProfiles(prisma, FACTS, l.id);
    expect(rows.map((r) => r.id)).toEqual([p.id]);
  });
});
