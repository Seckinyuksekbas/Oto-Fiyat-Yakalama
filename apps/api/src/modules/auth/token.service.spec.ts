import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { TokenService } from './token.service';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

async function make(k = keys()) {
  const svc = new TokenService(k as Env);
  await svc.onModuleInit();
  return svc;
}

afterEach(() => vi.useRealTimers());

describe('TokenService', () => {
  const claims = { userId: 'u1', role: 'ADMIN' as const, sessionId: 'fam1' };

  it('signs and verifies access tokens', async () => {
    const svc = await make();
    expect(await svc.verifyAccess(await svc.signAccess(claims))).toEqual(claims);
  });

  it('rejects tokens from another key pair', async () => {
    const a = await make();
    const b = await make();
    expect(await b.verifyAccess(await a.signAccess(claims))).toBeNull();
  });

  it('rejects expired tokens (15 min TTL)', async () => {
    const svc = await make();
    const token = await svc.signAccess(claims);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(await svc.verifyAccess(token)).toBeNull();
  });

  it('refuses to start when the private and public keys are not a pair', async () => {
    const a = keys();
    const b = keys();
    const svc = new TokenService({ JWT_PRIVATE_KEY: a.JWT_PRIVATE_KEY, JWT_PUBLIC_KEY: b.JWT_PUBLIC_KEY } as Env);
    const err = await svc.onModuleInit().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/JWT_PRIVATE_KEY.*JWT_PUBLIC_KEY/);
    expect(err?.message).not.toContain(a.JWT_PRIVATE_KEY.slice(30, 60));
  });

  it('rejects garbage and HS256 tokens', async () => {
    const svc = await make();
    expect(await svc.verifyAccess('garbage')).toBeNull();
    const hs = await new SignJWT({ role: 'SUPER_ADMIN', sid: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .sign(new TextEncoder().encode('k'.repeat(32)));
    expect(await svc.verifyAccess(hs)).toBeNull();
  });
});
