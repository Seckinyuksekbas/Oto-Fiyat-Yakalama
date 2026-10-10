import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { NotificationSweepService } from '../src/scheduler/notification-sweep.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { createAnalysis, createChannel, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let sweep: NotificationSweepService;
let queues: QueueRegistry;

beforeAll(async () => {
  ref = await createContext([MatchingModule, SchedulerModule]);
  prisma = ref.get(PrismaService);
  sweep = ref.get(NotificationSweepService);
  queues = ref.get(QueueRegistry);
});
afterAll(async () => ref.close());
beforeEach(async () => {
  await resetState(ref);
});

describe('NotificationSweepService', () => {
  it('requeues PENDING notifications whose enqueue was lost, only once and only when older than 60s', async () => {
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    const u = await createUser(ref);
    await createChannel(ref, u.id);
    await createProfile(ref, u.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const l = await createListing(ref, sourceId, { price: 960_000n });
    const a = await createAnalysis(ref, l.id);
    await ref.get(MatchService).process({ listingId: l.id, analysisId: a.id, event: 'NEW' });

    await queues.notify.obliterate({ force: true });
    await queues.notifyTelegram.obliterate({ force: true });
    await prisma.notification.updateMany({ data: { queuedAt: null } });

    expect(await sweep.requeuePending(new Date())).toBe(0); // henüz 60 sn geçmedi
    const later = new Date(Date.now() + 61_000);
    expect(await sweep.requeuePending(later)).toBe(2);
    const rows = await prisma.notification.findMany({ orderBy: { channel: 'asc' } });
    expect(rows.every((r) => r.queuedAt !== null)).toBe(true);
    expect(await queues.notify.getJob(`notify-${rows[0].id}`)).toBeTruthy();
    expect(await queues.notifyTelegram.getJob(`notify-${rows[1].id}`)).toBeTruthy();
    expect(await sweep.requeuePending(later)).toBe(0); // tekrar yok

    // SENT satırlar queuedAt=null olsa bile asla yeniden kuyruğa alınmaz.
    await prisma.notification.updateMany({ data: { status: 'SENT', queuedAt: null } });
    expect(await sweep.requeuePending(later)).toBe(0);
  });
});
