import type { NestExpressApplication } from '@nestjs/platform-express';
import { Encryptor, hashToken } from '@oto/server-common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, newAgent, registerUser, resetState, verifyEmail } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;

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

async function linkDirectly(userId: string, over: { isEnabled?: boolean; isVerified?: boolean } = {}) {
  await prisma.notificationChannel.create({
    data: {
      userId,
      type: 'TELEGRAM',
      config: app.get(Encryptor).encryptJson({ chatId: 4242 }),
      externalIdHash: hashToken('4242'),
      isVerified: over.isVerified ?? true,
      isEnabled: over.isEnabled ?? true,
    },
  });
}

describe('/me/channels', () => {
  it('lists IN_APP and TELEGRAM (not linked) and reports telegramAvailable=false when unconfigured', async () => {
    const A = await registerUser(app);
    const res = await A.agent.get('/api/v1/me/channels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        { type: 'IN_APP', isVerified: true, isEnabled: true },
        { type: 'TELEGRAM', linked: false, isVerified: false, isEnabled: false },
      ],
      telegramAvailable: false,
    });
    expect((await newAgent(app).get('/api/v1/me/channels')).status).toBe(401);
  });

  it('never leaks config, chatId or externalIdHash', async () => {
    const A = await registerUser(app);
    await linkDirectly(A.user.id);
    const res = await A.agent.get('/api/v1/me/channels');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('4242');
    expect(text).not.toContain(hashToken('4242'));
    expect(text).not.toContain('config');
    expect(text).not.toContain('externalIdHash');
    expect(res.body.items[1]).toEqual({ type: 'TELEGRAM', linked: true, isVerified: true, isEnabled: true });
    const patched = await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: false });
    expect(JSON.stringify(patched.body)).not.toMatch(/4242|config|externalIdHash/);
  });

  it('link without configuration → 503 FEATURE_DISABLED, checked before email verification', async () => {
    const unverified = await registerUser(app);
    const r1 = await unverified.agent.post('/api/v1/me/channels/telegram/link');
    expect(r1.status).toBe(503);
    expect(r1.body.error.code).toBe('FEATURE_DISABLED');

    const verified = await registerUser(app);
    await verifyEmail(app, verified.user.id);
    const r2 = await verified.agent.post('/api/v1/me/channels/telegram/link');
    expect(r2.status).toBe(503);
    expect(r2.body.error.code).toBe('FEATURE_DISABLED');
    expect(await prisma.telegramLinkToken.count()).toBe(0);
  });

  it('PATCH TELEGRAM toggles a linked channel; IN_APP → 400; unlinked → 404; DELETE unlinks', async () => {
    const A = await registerUser(app);
    // unlinked
    expect((await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: true })).status).toBe(404);
    expect((await A.agent.delete('/api/v1/me/channels/telegram')).status).toBe(404);
    // IN_APP
    const inApp = await A.agent.patch('/api/v1/me/channels/IN_APP').send({ isEnabled: false });
    expect(inApp.status).toBe(400);
    expect(inApp.body.error.code).toBe('INVALID_OPERATION');
    // bad type / body
    expect((await A.agent.patch('/api/v1/me/channels/EMAIL').send({ isEnabled: true })).status).toBe(400);
    expect((await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: 'yes' })).status).toBe(400);

    await linkDirectly(A.user.id);
    const off = await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ type: 'TELEGRAM', linked: true, isVerified: true, isEnabled: false });
    expect((await prisma.notificationChannel.findFirstOrThrow({ where: { userId: A.user.id, type: 'TELEGRAM' } })).isEnabled).toBe(false);
    const on = await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: true });
    expect(on.body.isEnabled).toBe(true);

    expect((await A.agent.delete('/api/v1/me/channels/telegram')).status).toBe(204);
    expect(await prisma.notificationChannel.count({ where: { userId: A.user.id, type: 'TELEGRAM' } })).toBe(0);
    expect((await A.agent.delete('/api/v1/me/channels/telegram')).status).toBe(404);
  });

  it('an unverified (never confirmed) channel row is treated as not linked', async () => {
    const A = await registerUser(app);
    await linkDirectly(A.user.id, { isVerified: false, isEnabled: false });
    expect((await A.agent.get('/api/v1/me/channels')).body.items[1].linked).toBe(false);
    expect((await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: true })).status).toBe(404);
  });

  it('enabling is refused when the plan has no TELEGRAM channel; disabling still works', async () => {
    const A = await registerUser(app);
    await linkDirectly(A.user.id, { isEnabled: false });
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.subscriptionPlan.update({
      where: { id: free.id },
      data: { limits: { ...(free.limits as object), channels: ['IN_APP'] } },
    });
    const res = await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('LIMIT_REACHED');
    expect(res.body.error.details).toEqual({ channel: 'TELEGRAM' });
    expect((await A.agent.patch('/api/v1/me/channels/TELEGRAM').send({ isEnabled: false })).status).toBe(200);
  });

  it('webhook returns 401 when Telegram is not configured / not in webhook mode', async () => {
    const res = await newAgent(app).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', 's'.repeat(40)).send({ update_id: 1 });
    expect(res.status).toBe(401);
  });
});
