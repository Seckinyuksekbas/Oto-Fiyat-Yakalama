import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Encryptor, hashToken } from '@oto/server-common';
import { PrismaService } from '../src/infra/prisma.service';
import { UserEventsService } from '../src/infra/user-events.service';
import { createTestApp, loginCookie, newAgent, registerUser, resetState, seedMatch, seedNotification, verifyEmail } from './helpers';
import { openSse } from './sse';
import { listRoutes } from './routes';

type Actor = Awaited<ReturnType<typeof registerUser>>;
type Case = (ctx: { A: Actor; B: Actor }) => Promise<void>;

let app: NestExpressApplication;

async function linkTelegram(userId: string) {
  await app.get(PrismaService).notificationChannel.create({
    data: { userId, type: 'TELEGRAM', config: app.get(Encryptor).encryptJson({ chatId: 9191 }), externalIdHash: hashToken('9191'), isVerified: true, isEnabled: true },
  });
}

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
    const before = (await A.agent.get('/api/v1/me')).body.user.name;
    const patch = await B.agent.patch('/api/v1/me').send({ name: 'B değişti' });
    expect(patch.status).toBe(200);
    expect((await B.agent.get('/api/v1/me')).body.user.name).toBe('B değişti');
    expect((await A.agent.get('/api/v1/me')).body.user.name).toBe(before);
  },
  'POST /me/change-password': async ({ A, B }) => {
    const change = await B.agent
      .post('/api/v1/me/change-password')
      .send({ currentPassword: B.password, newPassword: 'b-new-password-1' });
    expect(change.status).toBe(204);
    const old = await newAgent(app).post('/api/v1/auth/login').send({ email: B.email, password: B.password });
    expect(old.status).toBe(401);
    const fresh = await newAgent(app).post('/api/v1/auth/login').send({ email: B.email, password: 'b-new-password-1' });
    expect(fresh.status).toBe(200);
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
  'GET /me/search-profiles': async ({ A, B }) => {
    const created = await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A profili' });
    expect(created.status).toBe(201);
    const res = await B.agent.get('/api/v1/me/search-profiles');
    expect(res.body.items).toEqual([]);
    expect((await A.agent.get('/api/v1/me/search-profiles')).body.items.map((p: { id: string }) => p.id)).toEqual([created.body.id]);
  },
  'POST /me/search-profiles': async ({ A, B }) => {
    const created = await B.agent.post('/api/v1/me/search-profiles').send({ name: 'B profili' });
    expect(created.status).toBe(201);
    expect((await A.agent.get('/api/v1/me/search-profiles')).body.items).toEqual([]);
    expect((await B.agent.get('/api/v1/me/search-profiles')).body.items.map((p: { id: string }) => p.id)).toEqual([created.body.id]);
  },
  'GET /me/search-profiles/:id': async ({ A, B }) => {
    const created = await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' });
    expect(created.status).toBe(201);
    const { id } = created.body;
    expect((await B.agent.get(`/api/v1/me/search-profiles/${id}`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).status).toBe(200);
  },
  'POST /me/search-profiles/preview': async ({ A, B }) => {
    await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' });
    const res = await B.agent.post('/api/v1/me/search-profiles/preview').send({});
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(A.user.id);
  },
  'GET /me/matches': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    const { id: bId } = (await B.agent.post('/api/v1/me/search-profiles').send({ name: 'B' })).body;
    const aMatch = await seedMatch(app, A.user.id, id);
    const bMatch = await seedMatch(app, B.user.id, bId);
    expect((await A.agent.get('/api/v1/me/matches')).body.items.map((m: { id: number }) => m.id)).toEqual([aMatch]);
    expect((await B.agent.get('/api/v1/me/matches')).body.items.map((m: { id: number }) => m.id)).toEqual([bMatch]);
    expect((await B.agent.get(`/api/v1/me/matches?profileId=${id}`)).body.items).toEqual([]);
  },
  'GET /me/notifications': async ({ A, B }) => {
    const aN = await seedNotification(app, A.user.id);
    const bN = await seedNotification(app, B.user.id);
    const aIds = (await A.agent.get('/api/v1/me/notifications')).body.items.map((n: { id: number }) => n.id);
    const bRes = (await B.agent.get('/api/v1/me/notifications')).body;
    expect(aIds).toEqual([aN.id]);
    expect(bRes.items.map((n: { id: number }) => n.id)).toEqual([bN.id]);
    expect(bRes.unreadCount).toBe(1);
  },
  'POST /me/notifications/read': async ({ A, B }) => {
    const aN = await seedNotification(app, A.user.id);
    expect((await B.agent.post('/api/v1/me/notifications/read').send({ ids: [aN.id] })).body).toEqual({ updated: 0 });
    expect((await B.agent.post('/api/v1/me/notifications/read').send({ all: true })).body).toEqual({ updated: 0 });
    expect((await A.agent.get('/api/v1/me/notifications')).body.unreadCount).toBe(1);
  },
  'GET /me/notifications/stream': async ({ A, B }) => {
    const sa = await openSse(app, await loginCookie(app, A.email, A.password));
    const sb = await openSse(app, await loginCookie(app, B.email, B.password));
    try {
      await sa.waitFor((e) => e.event === 'ready');
      await sb.waitFor((e) => e.event === 'ready');
      await new Promise((r) => setTimeout(r, 300));
      const n = await seedNotification(app, A.user.id);
      await app.get(UserEventsService).publish(A.user.id, {
        type: 'notification',
        notification: { id: n.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: n.payload, createdAt: n.createdAt.toISOString() },
      });
      expect((await sa.waitFor((e) => e.event === 'notification')).data.id).toBe(n.id);
      await new Promise((r) => setTimeout(r, 500));
      expect(sb.events.some((e) => e.event === 'notification')).toBe(false);
    } finally {
      sa.close();
      sb.close();
    }
  },
  'GET /me/channels': async ({ A, B }) => {
    await linkTelegram(A.user.id);
    const aView = (await A.agent.get('/api/v1/me/channels')).body;
    const bView = (await B.agent.get('/api/v1/me/channels')).body;
    expect(aView.items[1]).toMatchObject({ type: 'TELEGRAM', linked: true });
    expect(bView.items[1]).toMatchObject({ type: 'TELEGRAM', linked: false });
    expect(JSON.stringify(bView)).not.toContain('9191');
  },
  'POST /me/channels/telegram/link': async ({ A, B }) => {
    await verifyEmail(app, A.user.id);
    await verifyEmail(app, B.user.id);
    const prisma = app.get(PrismaService);
    // Telegram yapılandırılmamış: yine de hiçbir token B adına A için oluşmaz
    const res = await B.agent.post('/api/v1/me/channels/telegram/link');
    expect([201, 503]).toContain(res.status);
    expect(await prisma.telegramLinkToken.count({ where: { userId: A.user.id } })).toBe(0);
    if (res.status === 201) expect(await prisma.telegramLinkToken.count({ where: { userId: B.user.id } })).toBe(1);
  },
  'PATCH /me/channels/:type': async ({ A, B }) => {
    await linkTelegram(A.user.id);
    expect((await B.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: false })).status).toBe(404);
    expect((await A.agent.get('/api/v1/me/channels')).body.items[1].isEnabled).toBe(true);
    expect((await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: false })).status).toBe(200);
    expect((await A.agent.get('/api/v1/me/channels')).body.items[1].isEnabled).toBe(false);
  },
  'DELETE /me/channels/telegram': async ({ A, B }) => {
    await linkTelegram(A.user.id);
    expect((await B.agent.delete('/api/v1/me/channels/telegram')).status).toBe(404);
    expect((await A.agent.get('/api/v1/me/channels')).body.items[1].linked).toBe(true);
    expect((await A.agent.delete('/api/v1/me/channels/telegram')).status).toBe(204);
    expect((await A.agent.get('/api/v1/me/channels')).body.items[1].linked).toBe(false);
  },
  'PATCH /me/search-profiles/:id': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.patch(`/api/v1/me/search-profiles/${id}`).send({ name: 'B' })).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).body.name).toBe('A');
  },
  'DELETE /me/search-profiles/:id': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.delete(`/api/v1/me/search-profiles/${id}`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).status).toBe(200);
  },
  'POST /me/search-profiles/:id/pause': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.post(`/api/v1/me/search-profiles/${id}/pause`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).body.status).toBe('ACTIVE');
  },
  'POST /me/search-profiles/:id/resume': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    await A.agent.post(`/api/v1/me/search-profiles/${id}/pause`);
    expect((await B.agent.post(`/api/v1/me/search-profiles/${id}/resume`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).body.status).toBe('PAUSED');
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
