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
    expect(systemLogDeletes.length).toBeGreaterThanOrEqual(3);
    expect(RETENTION_BATCH).toBe(5000);
  });
});
