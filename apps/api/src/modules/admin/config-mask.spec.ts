import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_SECRET_MASK,
  MaskedSecretMissingError,
  configKeySegments,
  containsMaskedSecret,
  isSecretConfigKey,
  maskConfigSecrets,
  mergeMaskedConfig,
} from './config-mask';

const secret = () => randomBytes(16).toString('hex');

describe('isSecretConfigKey (segment based)', () => {
  it.each([
    'apiKey', 'api_key', 'API_KEY', 'api-key', 'APIKey', 'key', 'token', 'accessToken', 'refresh_token', 'clientSecret', 'secretKey', 'privateKey',
    'accessKey', 'pass', 'password', 'dbPassword', 'passwd', 'auth', 'authorization', 'basicAuth', 'OAuth', 'credentials', 'awsCredential',
  ])('%s is secret', (k) => expect(isSecretConfigKey(k)).toBe(true));

  it.each([
    'baseUrl', 'pages', 'maxPages', 'user', 'name', 'region', 'keywords', 'keyboard', 'authorName', 'author', 'bypassCache', 'passengers',
    'sortKey', 'searchKey', 'maxKeys', 'keys', 'monkey', 'tokenizer', 'secretary',
  ])('%s is not secret', (k) => expect(isSecretConfigKey(k)).toBe(false));

  it('splits camelCase, acronyms, _, - and . into lowercase segments', () => {
    expect(configKeySegments('APIKey')).toEqual(['api', 'key']);
    expect(configKeySegments('x-api_key.v2')).toEqual(['x', 'api', 'key', 'v2']);
    expect(configKeySegments('clientSecretValue')).toEqual(['client', 'secret', 'value']);
  });
});

describe('maskConfigSecrets', () => {
  it('masks secret-named scalar values recursively (objects and arrays) and leaves the rest untouched', () => {
    const cfg = {
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: secret(),
      pages: 3,
      keywords: 'sedan',
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
      keywords: 'sedan',
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

  it('a secret-named parent masks ALL descendants (auth.user too); numbers are masked', () => {
    const pin = Number.parseInt(randomBytes(3).toString('hex'), 16);
    expect(maskConfigSecrets({ apiKey: pin, auth: { user: 'u', pass: secret(), opts: { realm: 'r', retries: 2, on: true } }, credentials: ['a', 'b'] })).toEqual({
      apiKey: CONFIG_SECRET_MASK,
      auth: { user: CONFIG_SECRET_MASK, pass: CONFIG_SECRET_MASK, opts: { realm: CONFIG_SECRET_MASK, retries: CONFIG_SECRET_MASK, on: true } },
      credentials: [CONFIG_SECRET_MASK, CONFIG_SECRET_MASK],
    });
  });
});

describe('containsMaskedSecret', () => {
  it('detects "***" only under a secret path', () => {
    expect(containsMaskedSecret({ baseUrl: 'x', apiKey: CONFIG_SECRET_MASK })).toBe(true);
    expect(containsMaskedSecret({ baseUrl: 'x', auth: { user: CONFIG_SECRET_MASK } })).toBe(true);
    expect(containsMaskedSecret({ baseUrl: 'x', list: [{ token: CONFIG_SECRET_MASK }] })).toBe(true);
    expect(containsMaskedSecret({ baseUrl: 'x', note: CONFIG_SECRET_MASK })).toBe(false);
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

  it('under a secret parent, masked non-secret-named children (auth.user) are restored too', () => {
    const stored = { auth: { user: secret(), pass: secret() } };
    expect(mergeMaskedConfig(stored, maskConfigSecrets(stored))).toEqual(stored);
    const user = secret();
    expect(mergeMaskedConfig(stored, { auth: { user, pass: CONFIG_SECRET_MASK } })).toEqual({ auth: { user, pass: stored.auth.pass } });
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

  describe('arrays (restored by index)', () => {
    const accounts = () => [
      { name: 'a', token: secret() },
      { name: 'b', token: secret() },
      { name: 'c', token: secret() },
    ];

    it('removing an element from a masked array is refused (would shift secrets onto other entries)', () => {
      const stored = { accounts: accounts() };
      const masked = maskConfigSecrets(stored) as { accounts: unknown[] };
      const err = (() => {
        try {
          mergeMaskedConfig(stored, { accounts: [masked.accounts[0], masked.accounts[2]] });
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(MaskedSecretMissingError);
      expect((err as Error).message).toMatch(/yeniden yazın/);
    });

    it('appending an element with "***" is refused too', () => {
      const stored = { accounts: accounts() };
      const masked = maskConfigSecrets(stored) as { accounts: unknown[] };
      expect(() => mergeMaskedConfig(stored, { accounts: [...masked.accounts, { name: 'd', token: CONFIG_SECRET_MASK }] })).toThrow(MaskedSecretMissingError);
    });

    it('reordering masked object elements is refused (non-secret fields differ at the same index)', () => {
      const stored = { accounts: accounts() };
      const masked = maskConfigSecrets(stored) as { accounts: unknown[] };
      expect(() => mergeMaskedConfig(stored, { accounts: [masked.accounts[1], masked.accounts[0], masked.accounts[2]] })).toThrow(MaskedSecretMissingError);
    });

    it('changing a non-secret field of a masked element is refused; of an element with a fresh secret it is allowed', () => {
      const stored = { accounts: accounts() };
      const masked = maskConfigSecrets(stored) as { accounts: Record<string, unknown>[] };
      expect(() => mergeMaskedConfig(stored, { accounts: [{ ...masked.accounts[0], name: 'z' }, masked.accounts[1], masked.accounts[2]] })).toThrow(
        MaskedSecretMissingError,
      );
      const fresh = secret();
      expect(mergeMaskedConfig(stored, { accounts: [{ name: 'z', token: fresh }, masked.accounts[1], masked.accounts[2]] })).toEqual({
        accounts: [{ name: 'z', token: fresh }, stored.accounts[1], stored.accounts[2]],
      });
    });

    it('an unchanged masked array round-trips; arrays without masks may change freely', () => {
      const stored = { accounts: accounts(), tags: ['x', 'y'] };
      const masked = maskConfigSecrets(stored) as { accounts: unknown[] };
      expect(mergeMaskedConfig(stored, { accounts: masked.accounts, tags: ['y'] })).toEqual({ accounts: stored.accounts, tags: ['y'] });
    });

    it('a masked primitive array under a secret key must keep its length', () => {
      const stored = { tokens: [secret(), secret()] };
      expect(mergeMaskedConfig(stored, { tokens: [CONFIG_SECRET_MASK, CONFIG_SECRET_MASK] })).toEqual(stored);
      expect(() => mergeMaskedConfig(stored, { tokens: [CONFIG_SECRET_MASK] })).toThrow(MaskedSecretMissingError);
    });
  });
});
