import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infra/redis.service';
import { createTestApp, registerUser, resetState, seedListing } from './helpers';

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('GET /catalog', () => {
  it('requires authentication', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/catalog/makes')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/v1/catalog/makes/bmw/models')).status).toBe(401);
  });

  it('lists makes by count desc then name, ignoring REMOVED', async () => {
    const A = await registerUser(app);
    for (let i = 0; i < 3; i += 1) await seedListing(app, { listing: { make: 'BMW' } });
    await seedListing(app, { listing: { make: 'Audi' } });
    await seedListing(app, { listing: { make: 'Volvo' } });
    await seedListing(app, { listing: { make: 'Fiat', status: 'REMOVED' } });
    const res = await A.agent.get('/api/v1/catalog/makes');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { make: 'BMW', count: 3 },
      { make: 'Audi', count: 1 },
      { make: 'Volvo', count: 1 },
    ]);
  });

  it('lists models case-insensitively by make and rejects overlong make', async () => {
    const A = await registerUser(app);
    await seedListing(app, { listing: { make: 'BMW', model: '3 Serisi' } });
    await seedListing(app, { listing: { make: 'BMW', model: '3 Serisi' } });
    await seedListing(app, { listing: { make: 'BMW', model: '5 Serisi' } });
    await seedListing(app, { listing: { make: 'Audi', model: 'A4' } });
    await seedListing(app, { listing: { make: 'BMW', model: 'X5', status: 'REMOVED' } });
    const res = await A.agent.get('/api/v1/catalog/makes/bmw/models');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { model: '3 Serisi', count: 2 },
      { model: '5 Serisi', count: 1 },
    ]);
    expect((await A.agent.get(`/api/v1/catalog/makes/${'x'.repeat(41)}/models`)).status).toBe(400);
  });

  it('caches in Redis for 10 minutes', async () => {
    const A = await registerUser(app);
    await seedListing(app, { listing: { make: 'BMW' } });
    expect((await A.agent.get('/api/v1/catalog/makes')).body.items).toEqual([{ make: 'BMW', count: 1 }]);
    expect((await A.agent.get('/api/v1/catalog/makes/bmw/models')).body.items).toHaveLength(1);
    const redis = app.get(RedisService);
    expect(await redis.exists('catalog:makes')).toBe(1);
    const ttl = await redis.ttl('catalog:makes');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(await redis.exists('catalog:models:bmw')).toBe(1);
    await seedListing(app, { listing: { make: 'Audi' } });
    expect((await A.agent.get('/api/v1/catalog/makes')).body.items).toEqual([{ make: 'BMW', count: 1 }]);
    await redis.flushdb();
    expect((await A.agent.get('/api/v1/catalog/makes')).body.items).toHaveLength(2);
  });
});
