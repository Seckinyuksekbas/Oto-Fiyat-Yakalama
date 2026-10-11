import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminQueues } from '../src/infra/admin-queues.service';
import { createTestApp } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('AdminQueues', () => {
  it('creates queues lazily, reuses them and reads job counts', async () => {
    const queues = app.get(AdminQueues);
    expect(queues.get('scrape')).toBe(queues.scrape);
    expect(queues.notifyTelegram.name).toBe('notify-telegram');
    const counts = await queues.analyze.getJobCounts('waiting', 'failed');
    expect(counts).toMatchObject({ waiting: expect.any(Number), failed: expect.any(Number) });
  });

  it('rejects unknown queue names', () => {
    expect(() => app.get(AdminQueues).get('nope' as never)).toThrow();
  });
});
