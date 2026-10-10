import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { UserEventsService } from '../src/infra/user-events.service';
import { SSE_MAX_LIFETIME_MS, SSE_PING_MS } from '../src/modules/me/notifications.controller';
import { cookieFrom, createTestApp, loginCookie, newAgent, registerUser, resetState, seedNotification } from './helpers';
import { openSse, type SseClient } from './sse';

let app: NestExpressApplication;
const open: SseClient[] = [];

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = (res: { body: { items: Array<{ id: number }> } }) => res.body.items.map((i) => i.id);

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('koşul zamanında sağlanmadı');
    await sleep(25);
  }
}

describe('/me/notifications', () => {
  it('lists own notifications newest first with unreadCount and cursor pagination', async () => {
    const A = await registerUser(app);
    const B = await registerUser(app);
    const a1 = await seedNotification(app, A.user.id, { readAt: new Date() });
    const a2 = await seedNotification(app, A.user.id);
    const a3 = await seedNotification(app, A.user.id);
    const tg = await seedNotification(app, A.user.id, { channel: 'TELEGRAM', status: 'FAILED', lastError: 'CHANNEL_UNAVAILABLE', kind: 'MATCH' });
    const b1 = await seedNotification(app, B.user.id);

    const all = await A.agent.get('/api/v1/me/notifications');
    expect(all.status).toBe(200);
    expect(ids(all)).toEqual([tg.id, a3.id, a2.id, a1.id]);
    expect(ids(all)).not.toContain(b1.id);
    expect(all.body.unreadCount).toBe(2);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.items[0]).toMatchObject({ channel: 'TELEGRAM', status: 'FAILED', lastError: 'CHANNEL_UNAVAILABLE', attempts: 0, readAt: null });

    const p1 = await A.agent.get('/api/v1/me/notifications?limit=2');
    expect(ids(p1)).toEqual([tg.id, a3.id]);
    expect(p1.body.nextCursor).toBe(a3.id);
    const p2 = await A.agent.get(`/api/v1/me/notifications?limit=2&cursor=${p1.body.nextCursor}`);
    expect(ids(p2)).toEqual([a2.id, a1.id]);
    expect(p2.body.nextCursor).toBeNull();

    expect(ids(await A.agent.get('/api/v1/me/notifications?channel=TELEGRAM&status=FAILED'))).toEqual([tg.id]);
    expect(ids(await A.agent.get('/api/v1/me/notifications?channel=IN_APP&status=FAILED'))).toEqual([]);
    expect(ids(await A.agent.get('/api/v1/me/notifications?unread=true'))).toEqual([a3.id, a2.id]);
    expect(ids(await A.agent.get('/api/v1/me/notifications?unread=true&channel=TELEGRAM'))).toEqual([]);
    expect((await A.agent.get('/api/v1/me/notifications?cursor=3000000000')).status).toBe(400);
  });

  it('marks read by ids (ignoring foreign/other-channel ids) and all', async () => {
    const A = await registerUser(app);
    const B = await registerUser(app);
    const a1 = await seedNotification(app, A.user.id);
    const a2 = await seedNotification(app, A.user.id);
    const a3 = await seedNotification(app, A.user.id);
    const aTg = await seedNotification(app, A.user.id, { channel: 'TELEGRAM', kind: 'MATCH' });
    const b1 = await seedNotification(app, B.user.id);
    const row = (id: number) => app.get(PrismaService).notification.findUniqueOrThrow({ where: { id } });

    const res = await A.agent.post('/api/v1/me/notifications/read').send({ ids: [a1.id, a2.id, b1.id, aTg.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });
    expect((await row(b1.id)).readAt).toBeNull();
    expect((await row(aTg.id)).readAt).toBeNull();
    expect((await row(a1.id)).readAt).not.toBeNull();
    expect((await A.agent.get('/api/v1/me/notifications')).body.unreadCount).toBe(1);

    expect((await A.agent.post('/api/v1/me/notifications/read').send({ all: true })).body).toEqual({ updated: 1 });
    expect((await row(a3.id)).readAt).not.toBeNull();
    expect((await A.agent.get('/api/v1/me/notifications')).body.unreadCount).toBe(0);
    expect((await row(b1.id)).readAt).toBeNull();
    expect((await A.agent.post('/api/v1/me/notifications/read').send({})).status).toBe(400);
  });

  it('SSE: sends ready, then live notifications for the owner only, and cleans up listeners', async () => {
    const A = await registerUser(app);
    const B = await registerUser(app);
    await seedNotification(app, A.user.id);
    const events = app.get(UserEventsService);
    const base = events.listenerCount();

    const sa = await openSse(app, await loginCookie(app, A.email, A.password));
    const sb = await openSse(app, await loginCookie(app, B.email, B.password));
    open.push(sa, sb);
    expect(sa.status).toBe(200);
    expect((await sa.waitFor((e) => e.event === 'ready')).data).toEqual({ unreadCount: 1 });
    expect((await sb.waitFor((e) => e.event === 'ready')).data).toEqual({ unreadCount: 0 });
    await until(() => events.listenerCount() === base + 2);
    await sleep(300); // psubscribe'ın oturması için

    const n = await seedNotification(app, A.user.id);
    await events.publish(A.user.id, {
      type: 'notification',
      notification: { id: n.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: n.payload, createdAt: n.createdAt.toISOString() },
    });
    const got = await sa.waitFor((e) => e.event === 'notification');
    expect(got.data.id).toBe(n.id);
    await sleep(500);
    expect(sb.events.filter((e) => e.event === 'notification')).toEqual([]);

    sa.close();
    sb.close();
    await until(() => events.listenerCount() === base);
    expect(events.listenerCount(A.user.id)).toBe(0);
  });

  it('SSE requires authentication', async () => {
    expect((await newAgent(app).get('/api/v1/me/notifications/stream')).status).toBe(401);
  });

  it('SSE timing constants: ping every 25 s, stream closes after 15 min', () => {
    expect(SSE_PING_MS).toBe(25_000);
    expect(SSE_MAX_LIFETIME_MS).toBe(15 * 60_000);
  });

  it('refresh-token reuse SECURITY notification is published live', async () => {
    const A = await registerUser(app);
    const login = await newAgent(app).post('/api/v1/auth/login').send({ email: A.email, password: A.password });
    const oldRefresh = cookieFrom(login, 'refresh_token')!;
    const sse = await openSse(app, `access_token=${cookieFrom(login, 'access_token')!}`);
    open.push(sse);
    await sse.waitFor((e) => e.event === 'ready');
    await sleep(300);

    const refresh = () => newAgent(app).post('/api/v1/auth/refresh').set('Cookie', `refresh_token=${oldRefresh}`);
    expect((await refresh()).status).toBe(204);
    expect((await refresh()).body.error.code).toBe('REFRESH_RACE');
    await app
      .get(PrismaService)
      .session.updateMany({ where: { userId: A.user.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    expect((await refresh()).body.error.code).toBe('REFRESH_REUSED');

    const ev = await sse.waitFor((e) => e.event === 'notification');
    expect(ev.data).toMatchObject({ kind: 'SECURITY', channel: 'IN_APP', payload: { type: 'REFRESH_REUSED' } });
  });
});
