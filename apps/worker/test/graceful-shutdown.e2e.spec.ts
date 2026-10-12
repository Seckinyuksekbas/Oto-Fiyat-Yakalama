import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeWithTimeout } from '../src/common/close-with-timeout';
import { bullConnection } from '../src/infra/bull';

const redisUrl = () => process.env.REDIS_URL as string;
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

async function setup(processor: () => Promise<void>) {
  const name = `shutdown-${randomUUID()}`;
  const queue = new Queue(name, { connection: bullConnection(redisUrl()) });
  cleanup.push(() => queue.obliterate({ force: true }).then(() => queue.close()));
  let started!: () => void;
  const active = new Promise<void>((r) => (started = r));
  const worker = new Worker(
    name,
    async () => {
      started();
      await processor();
    },
    { connection: bullConnection(redisUrl()) },
  );
  cleanup.push(() => worker.close(true));
  await queue.add('job', {});
  await active;
  return { queue, worker };
}

describe('closeWithTimeout with a real BullMQ worker', () => {
  it('forces the close when an active job outlives the limit (process can exit, job will be stalled)', async () => {
    const { worker } = await setup(() => new Promise<void>(() => undefined));
    const log = { warn: vi.fn(), error: vi.fn() };
    const t0 = Date.now();
    await expect(closeWithTimeout(worker, 300, log)).resolves.toBe('forced');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(log.warn).toHaveBeenCalled();
    expect(worker.closing).toBeTruthy();
  });

  it('waits for an active job that finishes within the limit', async () => {
    const { queue, worker } = await setup(() => new Promise<void>((r) => setTimeout(r, 200)));
    const log = { warn: vi.fn(), error: vi.fn() };
    await expect(closeWithTimeout(worker, 5000, log)).resolves.toBe('graceful');
    expect(log.warn).not.toHaveBeenCalled();
    expect(await queue.getCompletedCount()).toBe(1);
  });
});
