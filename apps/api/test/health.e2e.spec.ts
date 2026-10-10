import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('health & error format', () => {
  it('GET /api/v1/health/live → 200', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/v1/health/ready → 200 with all checks true', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ db: true, redis: true, migrations: true });
  });

  it('unknown route → 404 in standard error format', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Kayıt bulunamadı' } });
  });

  it('malformed JSON → 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('body over 100kb → 413', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
