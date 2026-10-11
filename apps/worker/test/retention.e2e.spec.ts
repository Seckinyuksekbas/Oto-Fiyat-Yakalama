import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RETENTION, RETENTION_BATCH, RetentionService } from '../src/scheduler/retention.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { createAnalysis, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let retention: RetentionService;

beforeAll(async () => {
  ref = await createContext([SchedulerModule]);
  prisma = ref.get(PrismaService);
  retention = ref.get(RetentionService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  vi.restoreAllMocks();
});

const DAY = 24 * 3600_000;
const NOW = new Date('2026-10-11T10:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
/** Sınırın 1 gün öncesi (silinir) ve 1 gün sonrası (kalır). */
const edge = (days: number) => ({ old: daysAgo(days + 1), fresh: daysAgo(days - 1) });
/** Hash sütunları için çalışma anında üretilen benzersiz değer (token biçimli literal yok). */
let hashSeq = 0;
const h = (p: string) => `${p}-${(hashSeq += 1)}-${Math.random().toString(36).slice(2)}`;

const EMPTY = {
  systemLogs: 0, scrapeErrors: 0, listingIssues: 0, auditLogs: 0, notifications: 0, sessions: 0,
  emailVerificationTokens: 0, passwordResetTokens: 0, telegramLinkTokens: 0, analyses: 0,
};

describe('RetentionService.run', () => {
  it('deletes rows past each retention window and keeps the rest', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const user = await createUser(ref);
    const logs = edge(RETENTION.systemLogDays);
    await prisma.systemLog.createMany({ data: [{ level: 'WARN', component: 'x', message: 'old', createdAt: logs.old }, { level: 'WARN', component: 'x', message: 'new', createdAt: logs.fresh }] });
    const se = edge(RETENTION.scrapeErrorDays);
    await prisma.scrapeError.createMany({ data: [{ sourceId: source.id, kind: 'NETWORK', message: 'old', transient: true, createdAt: se.old }, { sourceId: source.id, kind: 'NETWORK', message: 'new', transient: true, createdAt: se.fresh }] });
    const li = edge(RETENTION.listingIssueDays);
    await prisma.listingIssue.createMany({ data: [{ sourceId: source.id, field: 'price', problem: 'old', createdAt: li.old }, { sourceId: source.id, field: 'price', problem: 'new', createdAt: li.fresh }] });
    const al = edge(RETENTION.auditLogDays);
    await prisma.auditLog.createMany({ data: [{ actorId: user.id, action: 'x.old', createdAt: al.old }, { actorId: user.id, action: 'x.new', createdAt: al.fresh }] });
    const nf = edge(RETENTION.notificationDays);
    await prisma.notification.createMany({ data: [
      { userId: user.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: {}, createdAt: nf.old },
      { userId: user.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: {}, createdAt: nf.fresh },
    ] });

    const ss = edge(RETENTION.sessionDays);
    const future = new Date(NOW.getTime() + 10 * DAY);
    const session = (over: { expiresAt: Date; revokedAt?: Date }) => ({ userId: user.id, familyId: h('fam'), refreshTokenHash: h('rt'), ...over });
    await prisma.session.createMany({ data: [
      session({ expiresAt: ss.old }), // süresi sınırdan önce dolmuş → silinir
      session({ expiresAt: future, revokedAt: ss.old }), // sınırdan önce iptal → silinir
      session({ expiresAt: ss.fresh }), // süresi yakın zamanda dolmuş → kalır
      session({ expiresAt: future, revokedAt: ss.fresh }), // yakın zamanda iptal → kalır
      session({ expiresAt: future }), // etkin → kalır
    ] });

    const tk = edge(RETENTION.tokenDays);
    const tokenRows = (hashKey: 'tokenHash' | 'codeHash') => [
      { userId: user.id, [hashKey]: h('t'), expiresAt: tk.old }, // süresi dolmuş → silinir
      { userId: user.id, [hashKey]: h('t'), expiresAt: future, usedAt: tk.old }, // kullanılmış → silinir
      { userId: user.id, [hashKey]: h('t'), expiresAt: tk.fresh }, // kalır
      { userId: user.id, [hashKey]: h('t'), expiresAt: future, usedAt: tk.fresh }, // kalır
      { userId: user.id, [hashKey]: h('t'), expiresAt: future }, // kalır
    ];
    await prisma.emailVerificationToken.createMany({ data: tokenRows('tokenHash') as never });
    await prisma.passwordResetToken.createMany({ data: tokenRows('tokenHash') as never });
    await prisma.telegramLinkToken.createMany({ data: tokenRows('codeHash') as never });

    const r = await retention.run(NOW);
    expect(r).toEqual({
      ...EMPTY, systemLogs: 1, scrapeErrors: 1, listingIssues: 1, auditLogs: 1, notifications: 1, sessions: 2,
      emailVerificationTokens: 2, passwordResetTokens: 2, telegramLinkTokens: 2,
    });
    expect((await prisma.systemLog.findMany()).map((x) => x.message)).toEqual(['new']);
    expect((await prisma.scrapeError.findMany()).map((x) => x.message)).toEqual(['new']);
    expect((await prisma.listingIssue.findMany()).map((x) => x.problem)).toEqual(['new']);
    expect((await prisma.auditLog.findMany()).map((x) => x.action)).toEqual(['x.new']);
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.session.count()).toBe(3);
    expect(await prisma.emailVerificationToken.count()).toBe(3);
    expect(await prisma.passwordResetToken.count()).toBe(3);
    expect(await prisma.telegramLinkToken.count()).toBe(3);

    // İkinci koşu idempotent
    expect(await retention.run(NOW)).toEqual(EMPTY);
  });

  it('deletes only unreferenced old analyses; never cascades into matches or notifications', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const user = await createUser(ref);
    const profile = await createProfile(ref, user.id);
    const old = daysAgo(RETENTION.analysisDays + 10); // 100 gün
    const listing = await createListing(ref, source.id);

    // İlanın ilk analizi (ilk-görülme NEW kararı buna dayanır) korunur
    const first = await createAnalysis(ref, listing.id, { createdAt: daysAgo(200) });
    // (a) referanssız, eski → silinir
    const unref = await createAnalysis(ref, listing.id, { createdAt: old });
    // (c) bir ListingMatch tarafından referanslanan, eski → kalır
    const matched = await createAnalysis(ref, listing.id, { createdAt: old });
    const match = await prisma.listingMatch.create({
      data: { userId: user.id, searchProfileId: profile.id, listingId: listing.id, analysisId: matched.id, reason: 'NEW', matchedPrice: listing.price },
    });
    await prisma.notification.create({ data: { userId: user.id, matchId: match.id, channel: 'IN_APP', status: 'SENT', payload: {}, createdAt: daysAgo(5) } });
    // Eşleştirme kuyruğuna hiç gönderilememiş olay (dispatch bekliyor/takılı) → kalır
    const undispatched = await createAnalysis(ref, listing.id, { createdAt: old, matchEvent: 'PRICE_DROP', matchQueuedAt: null });
    // Gönderilmiş olay, eşleşme çıkmamış → silinir
    const dispatched = await createAnalysis(ref, listing.id, { createdAt: old, matchEvent: 'PRICE_DROP', matchQueuedAt: old });
    // (b) Listing.latestAnalysisId → kalır (createAnalysis son yazılanı latest yapar)
    const latest = await createAnalysis(ref, listing.id, { createdAt: old });
    // Yeni (sınırın içinde), referanssız → kalır
    const fresh = await prisma.listingAnalysis.create({
      data: { listingId: listing.id, engineVersion: 'rules-v1', opportunityScore: 1, comparableCount: 0, confidence: 'LOW', flags: [], explanation: {}, comparableIds: [], createdAt: daysAgo(RETENTION.analysisDays - 1) },
    });

    const matchesBefore = await prisma.listingMatch.count();
    const notificationsBefore = await prisma.notification.count();
    const r = await retention.run(NOW);
    expect(r.analyses).toBe(2);
    const left = (await prisma.listingAnalysis.findMany({ orderBy: { id: 'asc' } })).map((a) => a.id);
    expect(left).toEqual([first.id, matched.id, undispatched.id, latest.id, fresh.id]);
    expect(left).not.toContain(unref.id);
    expect(left).not.toContain(dispatched.id);
    expect(await prisma.listingMatch.count()).toBe(matchesBefore);
    expect(await prisma.notification.count()).toBe(notificationsBefore);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).latestAnalysisId).toBe(latest.id);
  });

  it('a 90+ day old notification is deleted without touching its match', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const user = await createUser(ref);
    const profile = await createProfile(ref, user.id);
    const listing = await createListing(ref, source.id);
    const a = await createAnalysis(ref, listing.id);
    const match = await prisma.listingMatch.create({
      data: { userId: user.id, searchProfileId: profile.id, listingId: listing.id, analysisId: a.id, reason: 'NEW', matchedPrice: listing.price },
    });
    await prisma.notification.create({ data: { userId: user.id, matchId: match.id, channel: 'IN_APP', status: 'SENT', payload: {}, createdAt: daysAgo(RETENTION.notificationDays + 1) } });
    expect((await retention.run(NOW)).notifications).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.listingMatch.findUnique({ where: { id: match.id } })).not.toBeNull();
  });

  it(`deletes in batches of ${RETENTION_BATCH}`, async () => {
    const old = daysAgo(RETENTION.systemLogDays + 1);
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ level: 'WARN' as const, component: 'bulk', message: `m${i}`, createdAt: old }));
    await prisma.systemLog.createMany({ data: rows });
    await prisma.systemLog.create({ data: { level: 'WARN', component: 'bulk', message: 'keep', createdAt: NOW } });
    const spy = vi.spyOn(prisma, '$executeRaw');
    const r = await retention.run(NOW);
    expect(r.systemLogs).toBe(12_000);
    expect(await prisma.systemLog.count()).toBe(1);
    const systemLogDeletes = spy.mock.calls.filter((c) => (c[0] as unknown as { strings?: string[]; sql?: string }).sql?.includes('"SystemLog"'));
    expect(systemLogDeletes.length).toBe(3); // 5000 + 5000 + 2000
  });

  it('first-analysis guard is per listing: another listing\'s only old analysis is kept even with a higher id', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const old = daysAgo(RETENTION.analysisDays + 10);
    const a = await createListing(ref, source.id);
    const b = await createListing(ref, source.id);
    await createAnalysis(ref, a.id, { createdAt: daysAgo(200) });
    const aOld = await createAnalysis(ref, a.id, { createdAt: old }); // A'nın ilk analizi değil → silinir
    const bFirst = await createAnalysis(ref, b.id, { createdAt: old }); // B'nin tek eski analizi, A'nınkilerden büyük id
    await createAnalysis(ref, a.id, { createdAt: daysAgo(1) });
    await createAnalysis(ref, b.id, { createdAt: daysAgo(1) }); // B'nin latest'i artık bu
    expect(bFirst.id).toBeGreaterThan(aOld.id);
    expect((await retention.run(NOW)).analyses).toBe(1);
    expect(await prisma.listingAnalysis.findUnique({ where: { id: aOld.id } })).toBeNull();
    expect(await prisma.listingAnalysis.findUnique({ where: { id: bFirst.id } })).not.toBeNull();
  });

  it('walks forward past protected rows: many protected old analyses are not rescanned', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const old = daysAgo(RETENTION.analysisDays + 10);
    const listing = await createListing(ref, source.id);
    const base = {
      listingId: listing.id, engineVersion: 'rules-v1', opportunityScore: 1, comparableCount: 0, confidence: 'LOW' as const,
      flags: [], explanation: {}, comparableIds: [], createdAt: old,
    };
    await prisma.listingAnalysis.create({ data: base }); // ilk analiz (korunur)
    // 6000 korunan (gönderilmemiş olay) + ardından 10 silinebilir
    await prisma.listingAnalysis.createMany({ data: Array.from({ length: 6000 }, () => ({ ...base, matchEvent: 'PRICE_DROP' as const })) });
    await prisma.listingAnalysis.createMany({ data: Array.from({ length: 10 }, () => base) });
    await createAnalysis(ref, listing.id, { createdAt: daysAgo(1) });
    const spy = vi.spyOn(prisma, '$queryRaw');
    expect((await retention.run(NOW)).analyses).toBe(10);
    // 6011 aday → 2 parti (5000 + 1011) + 1 boş (bitiş) sorgusu; korunanlar yeniden taranmaz
    expect(spy.mock.calls.filter((c) => (c[0] as unknown as { sql?: string }).sql?.includes('"ListingAnalysis"')).length).toBe(3);
    expect(await prisma.listingAnalysis.count()).toBe(6002);
  });

  it('a referenced analysis cannot be deleted directly (FK NO ACTION), so a match is never cascade-deleted', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const user = await createUser(ref);
    const profile = await createProfile(ref, user.id);
    const listing = await createListing(ref, source.id);
    const a = await createAnalysis(ref, listing.id);
    await createAnalysis(ref, listing.id); // a artık latest değil
    await prisma.listingMatch.create({
      data: { userId: user.id, searchProfileId: profile.id, listingId: listing.id, analysisId: a.id, reason: 'NEW', matchedPrice: listing.price },
    });
    await expect(prisma.$executeRaw`DELETE FROM "ListingAnalysis" WHERE id = ${a.id}`).rejects.toThrow(/23503|foreign key/i);
    expect(await prisma.listingMatch.count()).toBe(1);
  });

  /**
   * Eşzamanlı eşleştirme tx'ini BEFORE DELETE trigger'ı ile taklit eder: aday analiz silinirken (NOT EXISTS anlık
   * görüntüsünden SONRA) ona bir ListingMatch eklenir. CASCADE olsaydı ifade başarılı olur, eşleşme sessizce silinirdi.
   * `once=true`: yalnız ilk denemede ekler (sequence rollback'ten etkilenmez) → yeniden deneme başarılı olmalı.
   */
  async function raceSetup(once: boolean) {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const user = await createUser(ref);
    const profile = await createProfile(ref, user.id);
    const old = daysAgo(RETENTION.analysisDays + 10);
    const listing = await createListing(ref, source.id);
    await createAnalysis(ref, listing.id, { createdAt: daysAgo(200) }); // ilk
    const racy = await createAnalysis(ref, listing.id, { createdAt: old });
    const other = await createAnalysis(ref, listing.id, { createdAt: old });
    await createAnalysis(ref, listing.id, { createdAt: daysAgo(1) }); // latest
    await prisma.notification.create({
      data: { userId: user.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: {}, createdAt: daysAgo(RETENTION.notificationDays + 1) },
    });
    await prisma.$executeRawUnsafe('CREATE SEQUENCE IF NOT EXISTS test_race_seq');
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_race_insert_match() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = ${racy.id} THEN
          IF ${once ? "nextval('test_race_seq') = 1" : 'true'} THEN
            INSERT INTO "ListingMatch" ("userId", "searchProfileId", "listingId", "analysisId", reason, "matchedPrice")
            VALUES ('${user.id}', '${profile.id}', OLD."listingId", OLD.id, 'NEW', 1);
          END IF;
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_race BEFORE DELETE ON "ListingAnalysis" FOR EACH ROW EXECUTE FUNCTION test_race_insert_match()');
    return { racy, other };
  }
  async function raceTeardown() {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_race ON "ListingAnalysis"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_race_insert_match()');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS test_race_seq');
  }

  it('race: a match added after the snapshot makes the delete fail (no cascade); retention logs it and does not throw', async () => {
    const { racy, other } = await raceSetup(false);
    let r;
    try {
      r = await retention.run(NOW);
    } finally {
      await raceTeardown();
    }
    expect(r.analyses).toBe(0); // parti FK ile reddedildi (3 yeniden denemeden sonra), ertesi gün yeniden denenir
    expect(r.notifications).toBe(1); // diğer tablolar temizlendi
    expect(await prisma.listingAnalysis.findUnique({ where: { id: racy.id } })).not.toBeNull();
    expect(await prisma.listingAnalysis.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it('race: an FK rejection is retried from the same position and the batch then succeeds', async () => {
    const { racy, other } = await raceSetup(true);
    let r;
    try {
      r = await retention.run(NOW);
    } finally {
      await raceTeardown();
    }
    // İlk deneme FK ile reddedildi ve geri alındı (eklenen eşleşme de); yeniden denemede ikisi de silinir.
    expect(r.analyses).toBe(2);
    expect(await prisma.listingAnalysis.findUnique({ where: { id: racy.id } })).toBeNull();
    expect(await prisma.listingAnalysis.findUnique({ where: { id: other.id } })).toBeNull();
    expect(await prisma.listingMatch.count()).toBe(0);
  });

  it('a failing table is logged and the remaining tables are still cleaned', async () => {
    const user = await createUser(ref);
    await prisma.auditLog.create({ data: { action: 'x', createdAt: daysAgo(RETENTION.auditLogDays + 1) } });
    await prisma.notification.create({
      data: { userId: user.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: {}, createdAt: daysAgo(RETENTION.notificationDays + 1) },
    });
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_fail BEFORE DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_fail_delete()');
    try {
      const r = await retention.run(NOW);
      expect(r.auditLogs).toBe(0);
      expect(r.notifications).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail ON "AuditLog"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_delete()');
    }
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('deleting a listing (or its source) with analyses and matches still works: both FK paths in one statement', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    const user = await createUser(ref);
    const profile = await createProfile(ref, user.id);
    const listing = await createListing(ref, source.id);
    const a = await createAnalysis(ref, listing.id);
    const m = await prisma.listingMatch.create({
      data: { userId: user.id, searchProfileId: profile.id, listingId: listing.id, analysisId: a.id, reason: 'NEW', matchedPrice: listing.price },
    });
    await prisma.notification.create({ data: { userId: user.id, matchId: m.id, channel: 'IN_APP', status: 'SENT', payload: {} } });
    await prisma.listing.delete({ where: { id: listing.id } });
    expect(await prisma.listingAnalysis.count()).toBe(0);
    expect(await prisma.listingMatch.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    const l2 = await createListing(ref, source.id);
    const a2 = await createAnalysis(ref, l2.id);
    await prisma.listingMatch.create({ data: { userId: user.id, searchProfileId: profile.id, listingId: l2.id, analysisId: a2.id, reason: 'NEW', matchedPrice: l2.price } });
    await prisma.dataSource.delete({ where: { id: source.id } });
    expect(await prisma.listingMatch.count()).toBe(0);
    expect(await prisma.listingAnalysis.count()).toBe(0);
  });
});
