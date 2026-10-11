import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONFIG_SECRET_MASK, MaskedSecretMissingError, isSecretConfigKey, maskConfigSecrets, mergeMaskedConfig } from './config-mask';

const secret = () => randomBytes(16).toString('hex');

describe('isSecretConfigKey', () => {
  it.each(['apiKey', 'API_KEY', 'token', 'accessToken', 'clientSecret', 'pass', 'password', 'dbPassword', 'auth', 'authorization', 'basicAuth'])(
    '%s is secret',
    (k) => expect(isSecretConfigKey(k)).toBe(true),
  );
  it.each(['baseUrl', 'pages', 'maxPages', 'user', 'name', 'region'])('%s is not secret', (k) => expect(isSecretConfigKey(k)).toBe(false));
});

describe('maskConfigSecrets', () => {
  it('masks secret-named scalar values recursively (objects and arrays) and leaves the rest untouched', () => {
    const cfg = {
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: secret(),
      pages: 3,
      nested: { token: secret(), region: 'tr', deeper: { clientSecret: secret(), limit: 5 } },
      list: [{ password: secret(), user: 'u' }, 'plain'],
      authEnabled: true,
      authHeader: null,
      retryCount: 2,
    };
    const masked = maskConfigSecrets(cfg);
    expect(masked).toEqual({
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: CONFIG_SECRET_MASK,
      pages: 3,
      nested: { token: CONFIG_SECRET_MASK, region: 'tr', deeper: { clientSecret: CONFIG_SECRET_MASK, limit: 5 } },
      list: [{ password: CONFIG_SECRET_MASK, user: 'u' }, 'plain'],
      // boolean / null değer gizli bilgi taşımaz: olduğu gibi kalır
      authEnabled: true,
      authHeader: null,
      retryCount: 2,
    });
    // girdi değiştirilmez
    expect(cfg.apiKey).not.toBe(CONFIG_SECRET_MASK);
  });

  it('masks numbers under secret keys too, and a secret-named object is recursed (only its secret leaves masked)', () => {
    const pin = Number.parseInt(randomBytes(3).toString('hex'), 16);
    expect(maskConfigSecrets({ passcode: pin, auth: { user: 'u', pass: secret() } })).toEqual({
      passcode: CONFIG_SECRET_MASK,
      auth: { user: 'u', pass: CONFIG_SECRET_MASK },
    });
  });
});

describe('mergeMaskedConfig', () => {
  it('"***" keeps the stored value at the same path (nested), other values come from the patch', () => {
    const stored = { baseUrl: 'http://a.test', apiKey: secret(), nested: { token: secret(), pages: 3 }, list: [{ password: secret() }] };
    const merged = mergeMaskedConfig(stored, {
      baseUrl: 'http://b.test',
      apiKey: CONFIG_SECRET_MASK,
      nested: { token: CONFIG_SECRET_MASK, pages: 4 },
      list: [{ password: CONFIG_SECRET_MASK }],
    });
    expect(merged).toEqual({ baseUrl: 'http://b.test', apiKey: stored.apiKey, nested: { token: stored.nested.token, pages: 4 }, list: [{ password: stored.list[0]!.password }] });
  });

  it('a new value replaces the stored secret; omitted keys are dropped (PATCH replaces config wholesale)', () => {
    const stored = { baseUrl: 'http://a.test', apiKey: secret(), token: secret() };
    const fresh = secret();
    expect(mergeMaskedConfig(stored, { baseUrl: 'http://a.test', apiKey: fresh })).toEqual({ baseUrl: 'http://a.test', apiKey: fresh });
  });

  it('"***" for a secret with no stored value is refused', () => {
    expect(() => mergeMaskedConfig({ baseUrl: 'http://a.test' }, { baseUrl: 'http://a.test', apiKey: CONFIG_SECRET_MASK })).toThrow(MaskedSecretMissingError);
    expect(() => mergeMaskedConfig(null, { baseUrl: 'http://a.test', nested: { token: CONFIG_SECRET_MASK } })).toThrow(MaskedSecretMissingError);
  });

  it('"***" under a non-secret key is a literal value', () => {
    expect(mergeMaskedConfig({ note: 'x' }, { note: CONFIG_SECRET_MASK })).toEqual({ note: CONFIG_SECRET_MASK });
  });

  it('round-trip: patching back the masked view keeps the stored config byte-for-byte', () => {
    const stored = { baseUrl: 'http://a.test', apiKey: secret(), nested: { token: secret(), pages: 3 }, list: [{ password: secret(), user: 'u' }] };
    expect(mergeMaskedConfig(stored, maskConfigSecrets(stored))).toEqual(stored);
  });
});
