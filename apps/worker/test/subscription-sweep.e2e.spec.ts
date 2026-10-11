import type { TestingModule } from '@nestjs/testing';
import { userEventChannel } from '@oto/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { maxSearchProfilesFor } from '@oto/db';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { SUBSCRIPTION_SWEEP_RETRY_SEC, SubscriptionSweepService } from '../src/scheduler/subscription-sweep.service';
import { createContext, createProfile, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let sweep: SubscriptionSweepService;

beforeAll(async () => {
  ref = await createContext([SchedulerModule]);
  prisma = ref.get(PrismaService);
  sweep = ref.get(SubscriptionSweepService);
});
afterAll(async () => ref.close());
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await resetState(ref);
});

const NOW = new Date('2026-10-12T10:00:00Z');

async function subscribe(userId: string, planCode: string, endsAt: Date | null, status: 'ACTIVE' | 'CANCELED' = 'ACTIVE') {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: planCode } });
  return prisma.userSubscription.create({ data: { userId, planId: plan.id, status, startsAt: new Date('2026-01-01T00:00:00Z'), endsAt } });
}

describe('SubscriptionSweepService', () => {
  it('expires lapsed ACTIVE subscriptions and pauses excess profiles newest-first, notifying in-app', async () => {
    const u = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    const sub = await subscribe(u.id, 'PRO', new Date('2026-10-11T10:00:00Z'));
    const created = [];
    for (let i = 0; i < 4; i++) created.push(await createProfile(ref, u.id, { name: `P${i}`, createdAt: new Date(`2026-02-0${i + 1}T00:00:00Z`) }));
    await prisma.searchProfile.update({ where: { id: created[0].id }, data: { status: 'PAUSED' } }); // zaten duraklatılmış

    const received: string[] = [];
    const subscriber = ref.get(RedisService).duplicate();
    subscriber.on('message', (_c, m) => received.push(m));
    await subscriber.subscribe(userEventChannel(u.id));

    const res = await sweep.run(NOW);
    expect(res).toEqual({ expired: 1, paused: 1 });
    expect((await prisma.userSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('EXPIRED');
    // FREE = 2 profil: aktifler P1,P2,P3 -> en yeni (P3) duraklar
    const status = Object.fromEntries((await prisma.searchProfile.findMany()).map((p) => [p.name, p.status]));
    expect(status).toEqual({ P0: 'PAUSED', P1: 'ACTIVE', P2: 'ACTIVE', P3: 'PAUSED' });
    const notes = await prisma.notification.findMany({ where: { userId: u.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT' });
    expect(notes[0].payload).toMatchObject({ type: 'SUBSCRIPTION_EXPIRED', pausedProfiles: 1 });
    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await subscriber.quit();
    expect(received).toHaveLength(1);
  });

  it('does not touch live, non-expiring or already-canceled subscriptions, and does not notify when nothing is paused', async () => {
    const live = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await subscribe(live.id, 'PRO', new Date('2026-11-01T00:00:00Z'));
    const forever = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await subscribe(forever.id, 'PRO', null);
    const canceled = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await subscribe(canceled.id, 'PRO', new Date('2026-10-01T00:00:00Z'), 'CANCELED');
    const small = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    const smallSub = await subscribe(small.id, 'PRO', new Date('2026-10-10T00:00:00Z'));
    await createProfile(ref, small.id);
    for (const id of [live.id, forever.id]) for (let i = 0; i < 4; i++) await createProfile(ref, id);

    expect(await sweep.run(NOW)).toEqual({ expired: 1, paused: 0 });
    expect((await prisma.userSubscription.findUniqueOrThrow({ where: { id: smallSub.id } })).status).toBe('EXPIRED');
    expect(await prisma.searchProfile.count({ where: { status: 'PAUSED' } })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.userSubscription.count({ where: { status: 'CANCELED' } })).toBe(1);
  });

  it('keeps profiles active when the user still has another live subscription covering them', async () => {
    const u = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await subscribe(u.id, 'PRO', new Date('2026-10-11T00:00:00Z'));
    await subscribe(u.id, 'BUSINESS', null);
    for (let i = 0; i < 4; i++) await createProfile(ref, u.id);
    expect(await sweep.run(NOW)).toEqual({ expired: 1, paused: 0 });
    expect(await prisma.searchProfile.count({ where: { status: 'ACTIVE' } })).toBe(4);
  });

  it('runs once per Istanbul day (Redis NX) and again the next Istanbul day', async () => {
    const a = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await subscribe(a.id, 'PRO', new Date('2026-10-12T05:00:00Z'));
    expect(await sweep.run(NOW)).toEqual({ expired: 1, paused: 0 });
    const b = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    const subB = await subscribe(b.id, 'PRO', new Date('2026-10-12T08:00:00Z'));
    expect(await sweep.run(new Date('2026-10-12T11:00:00Z'))).toBeNull(); // aynı gün
    expect((await prisma.userSubscription.findUniqueOrThrow({ where: { id: subB.id } })).status).toBe('ACTIVE');
    expect(await ref.get(RedisService).exists('subs:sweep:20261012')).toBe(1);
    // 12 Ekim 21:00Z = 13 Ekim 00:00 İstanbul
    expect(await sweep.run(new Date('2026-10-12T21:00:01Z'))).toEqual({ expired: 1, paused: 0 });
  });

  it('on failure keeps the day marker with a short (10 min) TTL: no retry on every tick, retried once it lapses', async () => {
    const u = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await subscribe(u.id, 'PRO', new Date('2026-10-11T00:00:00Z'));
    const spy = vi.spyOn(sweep as unknown as { sweep: () => Promise<unknown> }, 'sweep').mockRejectedValueOnce(new Error('db down'));
    await expect(sweep.run(NOW)).rejects.toThrow('db down');
    const ttl = await ref.get(RedisService).ttl('subs:sweep:20261012');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SUBSCRIPTION_SWEEP_RETRY_SEC);
    // sonraki tick'ler (10 dk içinde) yeniden denemez
    expect(await sweep.run(NOW)).toBeNull();
    expect(await sweep.run(NOW)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1); // null dönen tick'ler süpürmeye ulaşmaz
    // 10 dk geçti (işaret düştü): yeniden denenir
    await ref.get(RedisService).del('subs:sweep:20261012');
    expect(await sweep.run(NOW)).toEqual({ expired: 1, paused: 0 });
  });

  it('caps unverified-email users at one active profile', async () => {
    const u = await createUser(ref); // doğrulanmamış
    await subscribe(u.id, 'PRO', new Date('2026-10-11T00:00:00Z'));
    for (let i = 0; i < 3; i++) await createProfile(ref, u.id, { name: `P${i}`, createdAt: new Date(`2026-02-0${i + 1}T00:00:00Z`) });
    expect(await sweep.run(NOW)).toEqual({ expired: 1, paused: 2 });
    const status = Object.fromEntries((await prisma.searchProfile.findMany()).map((p) => [p.name, p.status]));
    expect(status).toEqual({ P0: 'ACTIVE', P1: 'PAUSED', P2: 'PAUSED' });
  });

  it('one user failing does not block others; the day key is held briefly (10 min) and a later rerun repairs only the failed user', async () => {
    const mk = async (n: number) => {
      const u = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
      await subscribe(u.id, 'PRO', new Date('2026-10-11T00:00:00Z'));
      for (let i = 0; i < 4; i++) await createProfile(ref, u.id, { name: `U${n}P${i}`, createdAt: new Date(`2026-02-0${i + 1}T00:00:00Z`) });
      return u;
    };
    const bad = await mk(1);
    const good = await mk(2);
    const original = (sweep as unknown as { processUser: (id: string, now: Date) => Promise<unknown> }).processUser.bind(sweep);
    vi.spyOn(sweep as unknown as { processUser: typeof original }, 'processUser').mockImplementation(async (id, now) => {
      if (id === bad.id) throw new Error('boom');
      return original(id, now);
    });
    await expect(sweep.run(NOW)).rejects.toThrow('1 kullanıcıda');
    expect(await prisma.searchProfile.count({ where: { userId: good.id, status: 'PAUSED' } })).toBe(2);
    expect(await prisma.searchProfile.count({ where: { userId: bad.id, status: 'PAUSED' } })).toBe(0);
    expect(await ref.get(RedisService).ttl('subs:sweep:20261012')).toBeLessThanOrEqual(SUBSCRIPTION_SWEEP_RETRY_SEC);
    vi.restoreAllMocks();
    expect(await sweep.run(NOW)).toBeNull(); // kısa bekleme süresi dolmadan yeniden denenmez
    await ref.get(RedisService).del('subs:sweep:20261012');
    // Yeniden çalıştırma: bad kullanıcının abonelikleri hâlâ ACTIVE+süresi dolmuş; good zaten onarılmış (EXPIRED, fazla profil yok)
    expect(await sweep.run(NOW)).toEqual({ expired: 1, paused: 2 });
    expect(await prisma.searchProfile.count({ where: { userId: bad.id, status: 'PAUSED' } })).toBe(2);
    expect(await prisma.notification.count({ where: { userId: good.id } })).toBe(1); // çift bildirim yok
  });

  it('repairs a user whose subscription was already EXPIRED but whose profiles are still over the limit', async () => {
    const u = await createUser(ref, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    await prisma.userSubscription.create({
      data: { userId: u.id, planId: (await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PRO' } })).id, status: 'EXPIRED', endsAt: new Date('2026-10-10T00:00:00Z') },
    });
    for (let i = 0; i < 4; i++) await createProfile(ref, u.id, { name: `P${i}`, createdAt: new Date(`2026-02-0${i + 1}T00:00:00Z`) });
    expect(await sweep.run(NOW)).toEqual({ expired: 0, paused: 2 });
  });
});

describe('maxSearchProfilesFor', () => {
  it('limits unverified users to one profile at most', () => {
    expect(maxSearchProfilesFor({ maxSearchProfiles: 10 }, true)).toBe(10);
    expect(maxSearchProfilesFor({ maxSearchProfiles: 10 }, false)).toBe(1);
    expect(maxSearchProfilesFor({ maxSearchProfiles: 0 }, false)).toBe(0);
  });
});
