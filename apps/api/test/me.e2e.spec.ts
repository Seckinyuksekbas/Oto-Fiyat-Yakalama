import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, newAgent, registerUser, resetState } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

async function loginAgain(email: string, password: string) {
  const agent = newAgent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

describe('/me', () => {
  it('PATCH /me trims the name and validates length', async () => {
    const { agent } = await registerUser(app);
    const ok = await agent.patch('/api/v1/me').send({ name: '  Yeni İsim  ' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.name).toBe('Yeni İsim');
    expect((await agent.patch('/api/v1/me').send({ name: 'x'.repeat(81) })).status).toBe(400);
  });

  it('change-password keeps the current session and kills the others', async () => {
    const { agent, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    const wrong = await agent.post('/api/v1/me/change-password').send({ currentPassword: 'not-it-at-all', newPassword: 'another-strong-pw' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const res = await agent.post('/api/v1/me/change-password').send({ currentPassword: password, newPassword: 'another-strong-pw' });
    expect(res.status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('lists sessions with a current flag and revokes one by id', async () => {
    const { agent, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    const list = await agent.get('/api/v1/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const current = list.body.items.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    const otherId = list.body.items.find((s: { current: boolean }) => !s.current).id;
    expect((await agent.delete(`/api/v1/me/sessions/${otherId}`)).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await agent.delete(`/api/v1/me/sessions/${otherId}`)).status).toBe(404);
  });

  it('DELETE /me requires the password, anonymizes and frees the email', async () => {
    const { agent, user, email, password } = await registerUser(app, { email: 'bye@test.com' });
    expect((await agent.delete('/api/v1/me').send({ password: 'not-it-at-all' })).status).toBe(400);
    const res = await agent.delete('/api/v1/me').send({ password });
    expect(res.status).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('DELETED');
    expect(row.email).toBe(`deleted+${user.id}@invalid.local`);
    expect(await prisma.notificationChannel.count({ where: { userId: user.id } })).toBe(0);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(xhr).send({ email, password });
    expect(login.status).toBe(401);
    await registerUser(app, { email: 'bye@test.com' });
  });
});
