import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAnalysis, createChannel, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

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

async function deal(price = 960_000n) {
  const l = await createListing(ref, sourceId, { price });
  const a = await createAnalysis(ref, l.id);
  return { l, a };
}

describe('notification planning inside the match transaction', () => {
  it('creates IN_APP + TELEGRAM PENDING rows with a snapshot payload and enqueues them', async () => {
    const u = await createUser(ref);
    await createChannel(ref, u.id);
    const p = await createProfile(ref, u.id, { name: 'BMW', channels: ['IN_APP', 'TELEGRAM'] });
    const { l, a } = await deal();
    const out = await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect(out.status).toBe('MATCHED');
    const rows = await prisma.notification.findMany({ orderBy: { channel: 'asc' } });
    expect(rows.map((r) => [r.channel, r.status])).toEqual([['IN_APP', 'PENDING'], ['TELEGRAM', 'PENDING']]);
    expect(rows[0].payload).toMatchObject({
      type: 'MATCH', reason: 'NEW', profile: { id: p.id, name: 'BMW' }, previousPrice: null, limitExceeded: false,
      listing: { id: l.id, price: '960000' }, analysis: { confidence: 'HIGH', estimatedPrice: '1200000', discountPct: 0.2 },
    });
    expect(rows.every((r) => r.queuedAt !== null)).toBe(true);
    expect(await ref.get(QueueRegistry).notify.getJob(`notify-${rows[0].id}`)).toBeTruthy();
    expect(await ref.get(QueueRegistry).notifyTelegram.getJob(`notify-${rows[1].id}`)).toBeTruthy();
  });

  it('drops TELEGRAM when the channel is unverified/disabled or the plan lacks it', async () => {
    const u1 = await createUser(ref);
    await createChannel(ref, u1.id, { isEnabled: false });
    await createProfile(ref, u1.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const u2 = await createUser(ref);
    await createChannel(ref, u2.id);
    await createProfile(ref, u2.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.userSubscription.create({ data: { userId: u2.id, planId: free.id, limitOverrides: { channels: ['IN_APP'] } } });
    const { l, a } = await deal();
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect((await prisma.notification.findMany()).map((r) => r.channel)).toEqual(['IN_APP', 'IN_APP']);
  });

  it('daily limit under a concurrent burst: exactly the limit is PENDING, rest SKIPPED_LIMIT, IN_APP flagged', async () => {
    const u = await createUser(ref);
    await createChannel(ref, u.id);
    await createProfile(ref, u.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.userSubscription.create({ data: { userId: u.id, planId: free.id, limitOverrides: { maxNotificationsPerDay: 3 } } });
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      const { l, a } = await deal(900_000n + BigInt(i));
      jobs.push({ listingId: l.id, analysisId: a.id, event: 'NEW' as const });
    }
    await Promise.all(jobs.map((j) => svc.process(j)));
    const tg = await prisma.notification.findMany({ where: { channel: 'TELEGRAM' } });
    expect(tg.filter((n) => n.status === 'PENDING')).toHaveLength(3);
    expect(tg.filter((n) => n.status === 'SKIPPED_LIMIT')).toHaveLength(3);
    const inApp = await prisma.notification.findMany({ where: { channel: 'IN_APP' } });
    expect(inApp).toHaveLength(6);
    expect(inApp.filter((n) => (n.payload as { limitExceeded: boolean }).limitExceeded)).toHaveLength(3);
    expect(await ref.get(QueueRegistry).notifyTelegram.count()).toBe(3);
  });

  it('PRICE_DROP payload carries the previous matched price', async () => {
    const u = await createUser(ref);
    await createProfile(ref, u.id, { priceDropPct: 0.05 });
    const { l, a } = await deal(1_000_000n);
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    const drop = await createAnalysis(ref, l.id, { listingPrice: 900_000n });
    await svc.process({ listingId: l.id, analysisId: drop.id, event: 'PRICE_DROP', previousPrice: '1000000' });
    const n = await prisma.notification.findFirstOrThrow({ where: { payload: { path: ['reason'], equals: 'PRICE_DROP' } } });
    expect(n.payload).toMatchObject({ previousPrice: '1000000', listing: { price: '900000' } });
  });

  it('match and notifications commit atomically: a failing planner rolls back the match', async () => {
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const { l, a } = await deal();
    await prisma.subscriptionPlan.deleteMany({ where: { code: 'FREE' } }); // resolveUserPlan atar
    await expect(svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).rejects.toThrow(/FREE/);
    expect(await prisma.listingMatch.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});
