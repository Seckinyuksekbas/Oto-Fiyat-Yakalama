import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlertService } from '../src/common/alert.service';
import { HeartbeatService, HEARTBEAT_TTL_SEC, WORKER_SEEN_TTL_SEC } from '../src/common/heartbeat.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAdmin, createContext, resetState } from './helpers';

let ref: TestingModule;
beforeAll(async () => {
  ref = await createContext();
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
});

describe('AlertService', () => {
  it('always logs, but notifies active admins once per key within 30 minutes', async () => {
    const admin = await createAdmin(ref);
    await createAdmin(ref, 'SUSPENDED');
    const alerts = ref.get(AlertService);
    const alert = { key: 'source:1:blocked', level: 'ERROR' as const, component: 'collection', message: 'Demo erişimi engelledi' };
    await alerts.raise(alert);
    await alerts.raise(alert);
    const prisma = ref.get(PrismaService);
    expect(await prisma.systemLog.count({ where: { level: 'ERROR', component: 'collection' } })).toBe(2);
    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: admin.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT' });
    expect(notes[0].payload).toMatchObject({ key: 'source:1:blocked', message: 'Demo erişimi engelledi' });
    const ttl = await ref.get(RedisService).ttl('alert:source:1:blocked');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1800);
  });
});

describe('AlertService delivery', () => {
  it('does not suppress a key when no admin received it', async () => {
    const alerts = ref.get(AlertService);
    const alert = { key: 'source:2:blocked', level: 'ERROR' as const, component: 'collection', message: 'x' };
    await alerts.raise(alert);
    const prisma = ref.get(PrismaService);
    expect(await prisma.notification.count()).toBe(0);
    await createAdmin(ref);
    await alerts.raise(alert);
    expect(await prisma.notification.count()).toBe(1);
  });
});

describe('HeartbeatService', () => {
  it('publishes a heartbeat with TTL and removes it on shutdown', async () => {
    const hb = new HeartbeatService(ref.get(RedisService), { ROLE: 'worker' } as never);
    await hb.onModuleInit();
    const redis = ref.get(RedisService);
    expect(JSON.parse((await redis.get(hb.key))!)).toMatchObject({ role: 'worker', pid: process.pid });
    const ttl = await redis.ttl(hb.key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(HEARTBEAT_TTL_SEC);
    // Son görülme kaydı (ölü worker listesi için) aynı içerikle, 24 saat TTL ile
    expect(hb.seenKey).toBe(hb.key.replace('worker:heartbeat:', 'worker:seen:'));
    expect(await redis.get(hb.seenKey)).toBe(await redis.get(hb.key));
    const seenTtl = await redis.ttl(hb.seenKey);
    expect(seenTtl).toBeGreaterThan(HEARTBEAT_TTL_SEC);
    expect(seenTtl).toBeLessThanOrEqual(WORKER_SEEN_TTL_SEC);
    await hb.onModuleDestroy();
    expect(await redis.get(hb.key)).toBeNull();
    expect(await redis.get(hb.seenKey)).toBeNull();
  });
});

describe('QueueRegistry', () => {
  it('exposes the scrape, analyze and match queues', () => {
    const q = ref.get(QueueRegistry);
    expect([q.scrape.name, q.analyze.name, q.match.name]).toEqual(['scrape', 'analyze', 'match']);
  });
});
