import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { SessionService } from '../src/modules/auth/session.service';
import { createTestApp, resetState } from './helpers';

let app: NestExpressApplication;
let sessions: SessionService;
let prisma: PrismaService;
let userId: string;
const meta = { ip: '127.0.0.1', userAgent: 'vitest' };

beforeAll(async () => {
  app = await createTestApp();
  sessions = app.get(SessionService);
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
  userId = (await prisma.user.create({ data: { email: 's@test.com', name: 'S', passwordHash: 'x' } })).id;
});

describe('SessionService', () => {
  it('rotates a refresh token within the same family', async () => {
    const { familyId, refreshToken } = await sessions.create(userId, meta);
    const r = await sessions.rotate(refreshToken, meta);
    expect(r).toMatchObject({ kind: 'ok', userId, familyId, role: 'USER' });
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(r.refreshToken).not.toBe(refreshToken);
    expect((await sessions.rotate(r.refreshToken, meta)).kind).toBe('ok');
  });

  it('treats an old token inside the grace window as a race and keeps the family alive', async () => {
    const { refreshToken } = await sessions.create(userId, meta);
    const first = await sessions.rotate(refreshToken, meta);
    expect((await sessions.rotate(refreshToken, meta)).kind).toBe('race');
    if (first.kind !== 'ok') throw new Error('unreachable');
    expect((await sessions.rotate(first.refreshToken, meta)).kind).toBe('ok');
  });

  it('detects reuse after the grace window and revokes the whole family', async () => {
    const { familyId, refreshToken } = await sessions.create(userId, meta);
    const first = await sessions.rotate(refreshToken, meta);
    if (first.kind !== 'ok') throw new Error('unreachable');
    await prisma.session.updateMany({ where: { familyId, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    expect(await sessions.rotate(refreshToken, meta)).toEqual({ kind: 'reused', userId, familyId });
    expect((await sessions.rotate(first.refreshToken, meta)).kind).toBe('invalid');
  });

  it('only one of two concurrent rotations wins', async () => {
    const { refreshToken } = await sessions.create(userId, meta);
    const results = await Promise.all([sessions.rotate(refreshToken, meta), sessions.rotate(refreshToken, meta)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['ok', 'race']);
  });

  it('rejects unknown, expired and suspended-user tokens', async () => {
    expect((await sessions.rotate('nope', meta)).kind).toBe('invalid');
    const a = await sessions.create(userId, meta);
    await prisma.session.updateMany({ where: { familyId: a.familyId }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await sessions.rotate(a.refreshToken, meta)).kind).toBe('invalid');
    const b = await sessions.create(userId, meta);
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    expect((await sessions.rotate(b.refreshToken, meta)).kind).toBe('invalid');
  });

  it('lists active families and revokes all except one', async () => {
    const a = await sessions.create(userId, meta);
    const b = await sessions.create(userId, { ip: '10.0.0.1', userAgent: 'other' });
    expect((await sessions.listActive(userId)).map((s) => s.id).sort()).toEqual([a.familyId, b.familyId].sort());
    await sessions.revokeAllForUser(userId, { exceptFamilyId: a.familyId });
    expect((await sessions.listActive(userId)).map((s) => s.id)).toEqual([a.familyId]);
  });

  it('revokeFamilyForUser refuses another user\'s family', async () => {
    const other = await prisma.user.create({ data: { email: 'o@test.com', name: 'O', passwordHash: 'x' } });
    const theirs = await sessions.create(other.id, meta);
    expect(await sessions.revokeFamilyForUser(userId, theirs.familyId)).toBe(false);
    expect((await sessions.rotate(theirs.refreshToken, meta)).kind).toBe('ok');
  });
});
