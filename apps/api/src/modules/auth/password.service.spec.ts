import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { PasswordService } from './password.service';

const svc = (hibp: boolean) => new PasswordService({ HIBP_ENABLED: hibp } as Env);

afterEach(() => vi.unstubAllGlobals());

describe('PasswordService', () => {
  it('hashes with argon2id and verifies', async () => {
    const s = svc(false);
    const hash = await s.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await s.verify(hash, 'correct horse battery')).toBe(true);
    expect(await s.verify(hash, 'wrong password!!')).toBe(false);
  });

  it('verify returns false (not throw) for a malformed hash', async () => {
    expect(await svc(false).verify('not-a-hash', 'whatever123')).toBe(false);
  });

  it('dummyVerify always resolves false', async () => {
    expect(await svc(false).dummyVerify('anything-at-all')).toBe(false);
  });

  it('rejects a password found in HIBP', async () => {
    const sha = createHash('sha1').update('correct horse battery').digest('hex').toUpperCase();
    const fetchMock = vi.fn(async () => new Response(`0000000000000000000000000000000000A:1\r\n${sha.slice(5)}:42`));
    vi.stubGlobal('fetch', fetchMock);
    await expect(svc(true).assertNotBreached('correct horse battery')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(fetchMock).toHaveBeenCalledWith(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, expect.anything());
  });

  it('allows the password when HIBP is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(svc(true).assertNotBreached('correct horse battery')).resolves.toBeUndefined();
  });

  it('does not call HIBP when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await svc(false).assertNotBreached('correct horse battery');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
