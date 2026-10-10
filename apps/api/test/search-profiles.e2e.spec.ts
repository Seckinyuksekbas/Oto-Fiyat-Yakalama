import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, verifyEmail } from './helpers';

let app: NestExpressApplication;
const URL = '/api/v1/me/search-profiles';

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('/me/search-profiles', () => {
  it('creates with defaults and returns money as strings', async () => {
    const A = await registerUser(app);
    const res = await A.agent.post(URL).send({ name: 'BMW', make: 'BMW', priceMax: '1500000', minDiscountPct: 0.1, channels: ['TELEGRAM'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'BMW', make: 'BMW', priceMax: '1500000', priceMin: null, minDiscountPct: 0.1, priceDropPct: 0.05,
      minConfidence: 'MEDIUM', status: 'ACTIVE', channels: ['IN_APP', 'TELEGRAM'],
    });
    const list = await A.agent.get(URL);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([res.body.id]);
  });

  it('rejects invalid input with VALIDATION_FAILED', async () => {
    const A = await registerUser(app);
    const res = await A.agent.post(URL).send({ name: 'x', yearMin: 2022, yearMax: 2020 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await A.agent.post(URL).send({ name: 'x', channels: ['EMAIL'] })).status).toBe(400);
  });

  it('unverified accounts get at most one profile', async () => {
    const A = await registerUser(app);
    expect((await A.agent.post(URL).send({ name: '1' })).status).toBe(201);
    const second = await A.agent.post(URL).send({ name: '2' });
    expect(second.status).toBe(403);
    expect(second.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { limit: 1, reason: 'EMAIL_NOT_VERIFIED' } });
  });

  it('enforces plan limit under concurrent creates', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    const results = await Promise.all([1, 2, 3, 4].map((i) => A.agent.post(URL).send({ name: `p${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 403, 403]);
    expect(await app.get(PrismaService).searchProfile.count({ where: { userId: A.user.id } })).toBe(2);
  });

  it('applies limitOverrides', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    await app.get(PrismaService).userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { maxSearchProfiles: 3 } } });
    for (const i of [1, 2, 3]) expect((await A.agent.post(URL).send({ name: `p${i}` })).status).toBe(201);
    expect((await A.agent.post(URL).send({ name: 'p4' })).status).toBe(403);
    expect((await A.agent.get('/api/v1/me')).body.subscription.limits.maxSearchProfiles).toBe(3);
  });

  it('rejects channels the plan does not include', async () => {
    const A = await registerUser(app);
    const prisma = app.get(PrismaService);
    await prisma.userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { channels: ['IN_APP'] } } });
    const res = await A.agent.post(URL).send({ name: 'x', channels: ['TELEGRAM'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { channel: 'TELEGRAM' } });
  });

  it('patch merges, re-validates cross fields and keeps IN_APP', async () => {
    const A = await registerUser(app);
    const { id } = (await A.agent.post(URL).send({ name: 'x', yearMin: 2018 })).body;
    expect((await A.agent.patch(`${URL}/${id}`).send({ yearMax: 2017 })).status).toBe(400);
    const ok = await A.agent.patch(`${URL}/${id}`).send({ yearMax: 2020, channels: [] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ yearMin: 2018, yearMax: 2020, channels: ['IN_APP'] });
    expect((await A.agent.patch(`${URL}/${id}`).send({ make: null, model: 'X' })).status).toBe(400);
  });

  it('pause/resume and resume respects the active limit', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    const p1 = (await A.agent.post(URL).send({ name: '1' })).body.id;
    const p2 = (await A.agent.post(URL).send({ name: '2' })).body.id;
    expect((await A.agent.post(`${URL}/${p1}/pause`)).body.status).toBe('PAUSED');
    expect((await A.agent.post(`${URL}/${p1}/resume`)).body.status).toBe('ACTIVE');
    // Plan düşürüldü: limit 1, iki profil var
    await app.get(PrismaService).userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { maxSearchProfiles: 1 } } });
    await A.agent.post(`${URL}/${p2}/pause`);
    expect((await A.agent.post(`${URL}/${p2}/resume`)).status).toBe(403);
  });

  it('get/delete own profile; unknown id is 404', async () => {
    const A = await registerUser(app);
    const { id } = (await A.agent.post(URL).send({ name: 'x' })).body;
    expect((await A.agent.get(`${URL}/${id}`)).status).toBe(200);
    expect((await A.agent.delete(`${URL}/${id}`)).status).toBe(204);
    expect((await A.agent.get(`${URL}/${id}`)).status).toBe(404);
    expect((await A.agent.delete(`${URL}/${id}`)).status).toBe(404);
  });
});
