import { QueueName } from '@oto/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bullConnection } from '../src/infra/bull';
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

    // SENT / SKIPPED_LIMIT / FAILED satırlar queuedAt=null olsa bile asla yeniden kuyruğa alınmaz.
    for (const status of ['SENT', 'SKIPPED_LIMIT', 'FAILED'] as const) {
      await prisma.notification.updateMany({ data: { status, queuedAt: null } });
      expect(await sweep.requeuePending(later)).toBe(0);
    }
  });

  describe('stale queued PENDING rows (clause 2)', () => {
    async function pendingRow(channel: 'IN_APP' | 'TELEGRAM' = 'IN_APP') {
      const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
      const u = await createUser(ref);
      await createChannel(ref, u.id);
      await createProfile(ref, u.id, { channels: ['IN_APP', 'TELEGRAM'] });
      const l = await createListing(ref, sourceId, { price: 960_000n });
      const a = await createAnalysis(ref, l.id);
      await ref.get(MatchService).process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
      const row = await prisma.notification.findFirstOrThrow({ where: { channel } });
      await queues.notify.obliterate({ force: true });
      await queues.notifyTelegram.obliterate({ force: true });
      const old = new Date(Date.now() - 31 * 60_000);
      await prisma.notification.update({ where: { id: row.id }, data: { queuedAt: old } });
      return { row, old };
    }
    const queuedAt = async (id: number) => (await prisma.notification.findUniqueOrThrow({ where: { id } })).queuedAt!;

    it('re-adds a row whose job is missing and refreshes queuedAt; fresh queuedAt is left alone', async () => {
      const { row, old } = await pendingRow('TELEGRAM');
      await prisma.notification.updateMany({ where: { id: { not: row.id } }, data: { status: 'SENT' } });
      expect(await sweep.requeuePending(new Date(Date.now() - 20 * 60_000))).toBe(0); // 30 dk dolmadı
      expect(await sweep.requeuePending()).toBe(1);
      expect(await queues.notifyTelegram.getJob(`notify-${row.id}`)).toBeTruthy();
      expect((await queuedAt(row.id)).getTime()).toBeGreaterThan(old.getTime() + 60_000);
      expect(await sweep.requeuePending()).toBe(0);
    });

    it('removes a failed job and re-adds it', async () => {
      const { row } = await pendingRow();
      await prisma.notification.updateMany({ where: { id: { not: row.id } }, data: { status: 'SENT' } });
      const jobId = `notify-${row.id}`;
      await queues.notify.add('notify', { notificationId: row.id }, { jobId, attempts: 1, removeOnFail: { age: 3600 } });
      const w = new Worker(QueueName.NOTIFY, async () => { throw new UnrecoverableError('dead'); }, { connection: bullConnection(process.env.REDIS_URL!) });
      try {
        for (let i = 0; i < 100 && (await (await queues.notify.getJob(jobId))?.getState()) !== 'failed'; i++) await new Promise((r) => setTimeout(r, 100));
      } finally {
        await w.close();
      }
      expect(await (await queues.notify.getJob(jobId))!.getState()).toBe('failed');
      expect(await sweep.requeuePending()).toBe(1);
      expect(await (await queues.notify.getJob(jobId))!.getState()).toBe('waiting');
    });

    it('skips rows whose job is waiting or delayed', async () => {
      const { row, old } = await pendingRow();
      await prisma.notification.updateMany({ where: { id: { not: row.id } }, data: { status: 'SENT' } });
      const jobId = `notify-${row.id}`;
      await queues.notify.add('notify', { notificationId: row.id }, { jobId, delay: 60_000 });
      expect(await sweep.requeuePending()).toBe(0);
      await (await queues.notify.getJob(jobId))!.remove();
      await queues.notify.add('notify', { notificationId: row.id }, { jobId });
      expect(await sweep.requeuePending()).toBe(0);
      expect((await queuedAt(row.id)).getTime()).toBe(old.getTime());
    });
  });
});
