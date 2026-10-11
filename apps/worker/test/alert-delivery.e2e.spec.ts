import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { ADMIN_EVENTS_CHANNEL, adminEventSchema, type AdminEvent } from '@oto/shared';
import { FakeTelegramApi } from '@oto/telegram';
import type Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { ScrapeRunner } from '../src/collection/scrape-runner.service';
import { AlertService } from '../src/common/alert.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotifyService, TELEGRAM_UNAUTHORIZED_FLAG } from '../src/notifications/notify.service';
import { createAdmin, createChannel, createContext, createQueuedJob, createSource, resetState, startDemo } from './helpers';

@Module({ imports: [NotificationsModule, CollectionModule], exports: [NotificationsModule, CollectionModule] })
class DeliveryTestModule {}

const fake = new FakeTelegramApi();
let ref: TestingModule;
let prisma: PrismaService;
let demo: Awaited<ReturnType<typeof startDemo>>;
let sub: Redis;
const adminEvents: AdminEvent[] = [];
const FIRST = { attemptsMade: 0, maxAttempts: 5 };

beforeAll(async () => {
  const { apiBase, token } = await fake.start();
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_API_BASE = apiBase;
  ref = await createContext([DeliveryTestModule]);
  prisma = ref.get(PrismaService);
  demo = await startDemo();
  sub = ref.get(RedisService).duplicate();
  sub.on('message', (_ch: string, msg: string) => adminEvents.push(adminEventSchema.parse(JSON.parse(msg))));
  await sub.subscribe(ADMIN_EVENTS_CHANNEL);
});
afterAll(async () => {
  await sub.quit();
  await demo.close();
  await ref.close();
  await fake.close();
});
beforeEach(async () => {
  await resetState(ref);
  fake.reset();
  adminEvents.length = 0;
});
afterEach(async () => {
  const redis = ref.get(RedisService);
  const keys = await redis.keys('tg:chat:*');
  if (keys.length) await redis.del(...keys);
});

const settle = async (pred: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
};

describe('SYSTEM_ALERT Telegram delivery', () => {
  it('sends the HTML-escaped alert template (no match payload needed) and marks the row SENT', async () => {
    const admin = await createAdmin(ref);
    await createChannel(ref, admin.id, { chatId: 4242 });
    await ref.get(AlertService).raise({ key: 'src:1:down', level: 'ERROR', component: 'collection', message: 'Kaynak <Demo> & DOWN' });
    const row = await prisma.notification.findFirstOrThrow({ where: { channel: 'TELEGRAM', kind: 'SYSTEM_ALERT' } });
    const res = await ref.get(NotifyService).process(row.id, FIRST);
    expect(res).toEqual({ kind: 'DONE', status: 'SENT' });
    const sent = fake.requests.find((r) => r.method === 'sendMessage');
    expect(sent?.body.chat_id).toBe(4242);
    expect(sent?.body.parse_mode).toBe('HTML');
    expect(sent?.body.text).toContain('🚨 <b>Sistem alarmı</b>');
    expect(sent?.body.text).toContain('Kaynak &lt;Demo&gt; &amp; DOWN');
    expect(sent?.body.reply_markup).toBeUndefined();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SENT');
  });

  it('a Telegram 401 sets the unauthorized flag the monitor watches', async () => {
    const admin = await createAdmin(ref);
    await createChannel(ref, admin.id);
    await ref.get(AlertService).raise({ key: 'x', level: 'WARN', component: 'test', message: 'm' });
    const row = await prisma.notification.findFirstOrThrow({ where: { channel: 'TELEGRAM' } });
    fake.respondNext('sendMessage', { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    expect(await ref.get(NotifyService).process(row.id, FIRST)).toEqual({ kind: 'DONE', status: 'FAILED' });
    expect(await ref.get(RedisService).exists(TELEGRAM_UNAUTHORIZED_FLAG)).toBe(1);
  });
});

describe('ScrapeRunner job status events', () => {
  it('publishes RUNNING and the final status on admin:events', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const job = await createQueuedJob(ref, source.id);
    await ref.get(ScrapeRunner).run(job.id);
    await settle(() => adminEvents.filter((e) => e.type === 'job').length >= 2);
    const jobs = adminEvents.filter((e) => e.type === 'job');
    expect(jobs.map((e) => (e.type === 'job' ? e.status : null))).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(jobs[1]).toMatchObject({ type: 'job', jobId: job.id, sourceId: source.id });
  });

  it('publishes FAILED when a job is refused', async () => {
    const source = await createSource(ref, demo.baseUrl, { isActive: false });
    const job = await createQueuedJob(ref, source.id);
    await ref.get(ScrapeRunner).run(job.id);
    await settle(() => adminEvents.some((e) => e.type === 'job'));
    expect(adminEvents.filter((e) => e.type === 'job')).toEqual([expect.objectContaining({ type: 'job', jobId: job.id, sourceId: source.id, status: 'FAILED' })]);
  });
});
