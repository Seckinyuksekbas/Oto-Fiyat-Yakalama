import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, newAgent, registerUser, resetState } from './helpers';
import { listRoutes } from './routes';

type Actor = Awaited<ReturnType<typeof registerUser>>;
type Case = (ctx: { A: Actor; B: Actor }) => Promise<void>;

let app: NestExpressApplication;

async function aStillLogsIn(A: Actor) {
  const res = await newAgent(app).post('/api/v1/auth/login').send({ email: A.email, password: A.password });
  expect(res.status).toBe(200);
}

/**
 * Her /me route'u için B'nin A'nın verisine ulaşamadığını kanıtlayan senaryo.
 * Yeni bir /me route'u eklendiğinde buraya case eklenmezse "coverage" testi düşer.
 */
const CASES: Record<string, Case> = {
  'GET /me': async ({ A, B }) => {
    const res = await B.agent.get('/api/v1/me');
    expect(res.body.user.id).toBe(B.user.id);
    expect(JSON.stringify(res.body)).not.toContain(A.email);
  },
  'PATCH /me': async ({ A, B }) => {
    await B.agent.patch('/api/v1/me').send({ name: 'B değişti' });
    expect((await A.agent.get('/api/v1/me')).body.user.name).not.toBe('B değişti');
  },
  'POST /me/change-password': async ({ A, B }) => {
    await B.agent.post('/api/v1/me/change-password').send({ currentPassword: B.password, newPassword: 'b-new-password-1' });
    await aStillLogsIn(A);
  },
  'GET /me/sessions': async ({ A, B }) => {
    const aIds = (await A.agent.get('/api/v1/me/sessions')).body.items.map((s: { id: string }) => s.id);
    const bIds = (await B.agent.get('/api/v1/me/sessions')).body.items.map((s: { id: string }) => s.id);
    expect(bIds.some((id: string) => aIds.includes(id))).toBe(false);
  },
  'DELETE /me/sessions/:id': async ({ A, B }) => {
    const [aSession] = (await A.agent.get('/api/v1/me/sessions')).body.items;
    expect((await B.agent.delete(`/api/v1/me/sessions/${aSession.id}`)).status).toBe(404);
    expect((await A.agent.post('/api/v1/auth/refresh')).status).toBe(204);
  },
  'DELETE /me': async ({ A, B }) => {
    expect((await B.agent.delete('/api/v1/me').send({ password: B.password })).status).toBe(204);
    await aStillLogsIn(A);
  },
};

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

describe('user isolation matrix', () => {
  it('covers every /me route', () => {
    const meRoutes = listRoutes(app)
      .filter((r) => r.path === '/me' || r.path.startsWith('/me/'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(meRoutes).toEqual(Object.keys(CASES).sort());
  });

  for (const [route, run] of Object.entries(CASES)) {
    it(`B cannot read or modify A's data via ${route}`, async () => {
      const A = await registerUser(app);
      const B = await registerUser(app);
      await run({ A, B });
    });
  }
});
