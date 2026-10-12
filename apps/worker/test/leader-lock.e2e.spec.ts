import { hostname } from 'node:os';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, type Env } from '../src/config/env';
import { LEADER_LOCK_KEY, LeaderLockService } from '../src/scheduler/leader-lock.service';
import { SchedulerLoop } from '../src/scheduler/scheduler-loop.service';

let env: Env;
let redis: Redis;
const services: LeaderLockService[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lock(opts: { ttlMs?: number; renewMs?: number } = {}): LeaderLockService {
  const s = new LeaderLockService(env, { ttlMs: 30_000, renewMs: 10_000, ...opts });
  services.push(s);
  return s;
}

beforeAll(() => {
  env = parseEnv(process.env, () => undefined);
  redis = new Redis(env.REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  await redis.del(LEADER_LOCK_KEY);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((s) => s.onApplicationShutdown()));
});

describe('LeaderLockService', () => {
  it('only one of two instances on the same Redis becomes leader; value is <host>:<pid>:<uuid> with PX 30000', async () => {
    const a = lock();
    const b = lock();
    const results = await Promise.all([a.tryAcquire(), b.tryAcquire()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
    const value = await redis.get(LEADER_LOCK_KEY);
    expect(value).toMatch(new RegExp(`^${escapeRe(hostname())}:${process.pid}:[0-9a-f-]{36}$`));
    const pttl = await redis.pttl(LEADER_LOCK_KEY);
    expect(pttl).toBeGreaterThan(29_000);
    expect(pttl).toBeLessThanOrEqual(30_000);
  });

  it('renews its own lock with CAS (TTL refreshed) and stays leader', async () => {
    const a = lock({ ttlMs: 10_000 });
    expect(await a.tryAcquire()).toBe(true);
    await sleep(400);
    const before = await redis.pttl(LEADER_LOCK_KEY);
    expect(await a.tryAcquire()).toBe(true);
    const after = await redis.pttl(LEADER_LOCK_KEY);
    expect(after).toBeGreaterThan(9000);
    expect(after).toBeGreaterThan(before);
    expect(a.isLeader()).toBe(true);
  });

  it('re-acquires in the same call when its own lock expired (renew CAS returned 0)', async () => {
    const a = lock({ ttlMs: 300 });
    expect(await a.tryAcquire()).toBe(true);
    await sleep(450); // anahtar süresi doldu, kimse almadı
    expect(await a.tryAcquire()).toBe(true);
    expect(await redis.get(LEADER_LOCK_KEY)).toBe(a.value);
  });

  it('logs "scheduler leader acquired" once and the standby transition once, at info', async () => {
    const info = vi.spyOn(Logger.prototype, 'log');
    const a = lock();
    const b = lock();
    await a.tryAcquire();
    await a.tryAcquire();
    await b.tryAcquire();
    await b.tryAcquire();
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l === 'scheduler leader acquired')).toHaveLength(1);
    expect(lines.filter((l) => /standby/.test(l))).toHaveLength(1);
  });

  it('hands over immediately when the leader releases', async () => {
    const a = lock();
    const b = lock();
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    await a.release();
    expect(a.isLeader()).toBe(false);
    expect(await b.tryAcquire()).toBe(true);
  });

  it('release never deletes a lock held by another instance (compare-and-delete)', async () => {
    const a = lock();
    const b = lock();
    expect(await a.tryAcquire()).toBe(true);
    await redis.set(LEADER_LOCK_KEY, 'someone-else', 'PX', 30_000);
    await a.release();
    expect(await redis.get(LEADER_LOCK_KEY)).toBe('someone-else');
    expect(await b.tryAcquire()).toBe(false);
  });

  it('another instance takes over after the leader stops renewing and PX expires', async () => {
    const a = lock({ ttlMs: 300 });
    const b = lock({ ttlMs: 300 });
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    await sleep(450); // a yenilemedi (çöktü/dondu)
    expect(a.isLeader()).toBe(false); // kira süresi dolduğu için kendini de lider saymaz
    expect(await b.tryAcquire()).toBe(true);
  });

  it('a lost lock flips isLeader to false and logs a warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const a = lock();
    expect(await a.tryAcquire()).toBe(true);
    await redis.set(LEADER_LOCK_KEY, 'stolen', 'PX', 30_000);
    expect(await a.tryAcquire()).toBe(false);
    expect(a.isLeader()).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => /leader lock lost/.test(l))).toBe(true);
  });

  it('start(): renews in the background; the standby retries every renew interval and takes over', async () => {
    const a = lock({ ttlMs: 2000, renewMs: 100 });
    const b = lock({ ttlMs: 2000, renewMs: 100 });
    const acquired = vi.fn();
    b.onAcquired(acquired);
    await a.start();
    await b.start();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    await sleep(300);
    expect(a.isLeader()).toBe(true);
    await a.onApplicationShutdown(); // release
    await vi.waitFor(() => expect(b.isLeader()).toBe(true), { timeout: 2000, interval: 50 });
    expect(acquired).toHaveBeenCalledTimes(1);
  });

  it('onApplicationShutdown releases the lock', async () => {
    const a = lock();
    await a.start();
    expect(await redis.exists(LEADER_LOCK_KEY)).toBe(1);
    await a.onApplicationShutdown();
    expect(await redis.exists(LEADER_LOCK_KEY)).toBe(0);
  });
});

describe('SchedulerLoop leader gating', () => {
  function loopWith(isLeader: () => boolean) {
    const tick = vi.fn(async () => 0);
    const stub = (...names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn(async () => 0)]));
    const monitor = { check: vi.fn(async () => []) };
    const retention = { run: vi.fn(async () => ({})) };
    const leader = { isLeader, start: vi.fn(async () => undefined), onAcquired: vi.fn() };
    const loop = new SchedulerLoop(
      { tick } as never,
      stub('maybeRunNightly', 'requeuePendingMatches') as never,
      stub('requeuePending') as never,
      stub('run') as never,
      monitor as never,
      retention as never,
      leader as never,
      { ...env, MONITOR_INTERVAL_MS: 60_000 },
    );
    return { loop, tick, monitor, retention, leader };
  }

  it('a non-leader loop never ticks, monitors or cleans up', async () => {
    const { loop, tick, monitor, retention } = loopWith(() => false);
    await loop.safeTick();
    await loop.safeCleanup();
    expect(tick).not.toHaveBeenCalled();
    expect(monitor.check).not.toHaveBeenCalled();
    expect(retention.run).not.toHaveBeenCalled();
  });

  it('the leader loop ticks, monitors and cleans up', async () => {
    const { loop, tick, monitor, retention } = loopWith(() => true);
    await loop.safeTick();
    await loop.safeCleanup();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(monitor.check).toHaveBeenCalledTimes(1);
    expect(retention.run).toHaveBeenCalledTimes(1);
  });

  it('bootstrap wiring: starts the lock and runs cleanup when leadership is acquired', async () => {
    let onAcquired: (() => void) | undefined;
    const { loop, retention, leader } = loopWith(() => true);
    leader.onAcquired.mockImplementation((fn: () => void) => {
      onAcquired = fn;
    });
    await loop.onApplicationBootstrap();
    try {
      expect(leader.start).toHaveBeenCalledTimes(1);
      expect(onAcquired).toBeDefined();
      onAcquired?.();
      await vi.waitFor(() => expect(retention.run).toHaveBeenCalledTimes(1));
    } finally {
      loop.onModuleDestroy();
    }
  });

  it('stops the remaining tick steps as soon as leadership is lost', async () => {
    let leader = true;
    const { loop, tick, monitor } = loopWith(() => leader);
    tick.mockImplementation(async () => {
      leader = false;
      return 0;
    });
    await loop.safeTick();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(monitor.check).not.toHaveBeenCalled();
  });
});
