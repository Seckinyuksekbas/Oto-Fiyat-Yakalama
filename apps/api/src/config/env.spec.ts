import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

function pemPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ...pemPair(),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
};

/** Geçerli bir production yapılandırması (her kural testi tek bir alanı bozar). */
const prodBase = {
  ...base,
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://oto.example',
  COOKIE_SECURE: 'true',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.oto.example',
};

describe('parseEnv', () => {
  it('applies defaults and unescapes PEM newlines', () => {
    const escaped = base.JWT_PRIVATE_KEY.replace(/\n/g, '\\n');
    const env = parseEnv({ ...base, JWT_PRIVATE_KEY: escaped });
    expect(env.PORT).toBe(3001);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.HIBP_ENABLED).toBe(false);
    expect(env.JWT_PRIVATE_KEY).toBe(base.JWT_PRIVATE_KEY);
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.SMTP_REQUIRE_TLS).toBe(false);
    expect(env.SMTP_USER).toBeUndefined();
  });

  it('fails fast listing every missing variable', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL.*REDIS_URL/s);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => parseEnv({ ...base, DATA_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(
      /DATA_ENCRYPTION_KEY/,
    );
  });

  it('bounds TRUST_PROXY to 0..5 and PORT to a valid port', () => {
    expect(parseEnv({ ...base, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(0);
    expect(parseEnv({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(() => parseEnv({ ...base, TRUST_PROXY: '6' })).toThrow(/TRUST_PROXY/);
    expect(() => parseEnv({ ...base, TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    expect(() => parseEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(parseEnv({ ...base, PORT: '3101' }).PORT).toBe(3101);
  });

  it('reads SMTP auth/TLS settings and requires SMTP_PASS with SMTP_USER', () => {
    const env = parseEnv({
      ...base,
      SMTP_USER: 'mailer',
      SMTP_PASS: randomBytes(8).toString('hex'),
      SMTP_SECURE: 'true',
      SMTP_REQUIRE_TLS: 'true',
    });
    expect(env.SMTP_USER).toBe('mailer');
    expect(env.SMTP_SECURE).toBe(true);
    expect(env.SMTP_REQUIRE_TLS).toBe(true);
    expect(() => parseEnv({ ...base, SMTP_USER: 'mailer' })).toThrow(/SMTP_PASS/);
  });

  it('rejects JWT keys that are not valid PEM keys', () => {
    expect(() => parseEnv({ ...base, JWT_PRIVATE_KEY: 'not-a-key' })).toThrow(/JWT_PRIVATE_KEY/);
    expect(() => parseEnv({ ...base, JWT_PUBLIC_KEY: 'not-a-key' })).toThrow(/JWT_PUBLIC_KEY/);
  });
});

describe('parseEnv production rules', () => {
  it('accepts a valid production configuration with secure defaults', () => {
    const env = parseEnv(prodBase);
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.SMTP_REQUIRE_TLS).toBe(true);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('requires COOKIE_SECURE=true', () => {
    expect(() => parseEnv({ ...prodBase, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  it('requires an https PUBLIC_BASE_URL', () => {
    expect(() => parseEnv({ ...prodBase, PUBLIC_BASE_URL: 'http://example.com' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('rejects a loopback PUBLIC_BASE_URL', () => {
    expect(() => parseEnv({ ...prodBase, PUBLIC_BASE_URL: 'https://localhost' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => parseEnv({ ...prodBase, PUBLIC_BASE_URL: 'https://127.0.0.1' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => parseEnv({ ...prodBase, PUBLIC_BASE_URL: 'https://[::1]' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('requires MAIL_TRANSPORT=smtp', () => {
    expect(() => parseEnv({ ...prodBase, MAIL_TRANSPORT: 'json' })).toThrow(/MAIL_TRANSPORT/);
  });

  it('rejects a localhost SMTP_HOST (including the default)', () => {
    expect(() => parseEnv({ ...prodBase, SMTP_HOST: 'localhost' })).toThrow(/SMTP_HOST/);
    expect(() => parseEnv({ ...prodBase, SMTP_HOST: '127.0.0.1' })).toThrow(/SMTP_HOST/);
    const { SMTP_HOST: _omit, ...noHost } = prodBase;
    expect(() => parseEnv(noHost)).toThrow(/SMTP_HOST/);
  });

  it('allows SMTP_REQUIRE_TLS to be turned off explicitly', () => {
    expect(parseEnv({ ...prodBase, SMTP_REQUIRE_TLS: 'false' }).SMTP_REQUIRE_TLS).toBe(false);
  });

  it('never echoes secret values in the error message', () => {
    const secret = randomBytes(24).toString('hex');
    const encKey = randomBytes(16).toString('base64');
    let message = '';
    try {
      parseEnv({ ...prodBase, JWT_PRIVATE_KEY: secret, DATA_ENCRYPTION_KEY: encKey, SMTP_PASS: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/JWT_PRIVATE_KEY/);
    expect(message).toMatch(/DATA_ENCRYPTION_KEY/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(encKey);
  });
});

describe('parseEnv telegram', () => {
  it('defaults to polling with no token', () => {
    const env = parseEnv(base);
    expect(env.TELEGRAM_MODE).toBe('polling');
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_API_BASE).toBe('https://api.telegram.org');
  });

  it('requires a bot username when a token is set', () => {
    expect(() => parseEnv({ ...base, TELEGRAM_BOT_TOKEN: '1:abc' })).toThrow(/TELEGRAM_BOT_USERNAME/);
    expect(parseEnv({ ...base, TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_BOT_USERNAME: 'otofirsat_bot' }).TELEGRAM_MODE).toBe('polling');
  });

  it('requires a 32+ char secret in webhook mode with a token', () => {
    const tg = { ...base, TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_BOT_USERNAME: 'otofirsat_bot', TELEGRAM_MODE: 'webhook' };
    expect(() => parseEnv(tg)).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => parseEnv({ ...tg, TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(parseEnv({ ...tg, TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32) }).TELEGRAM_WEBHOOK_SECRET).toBe('a'.repeat(32));
    expect(parseEnv({ ...base, TELEGRAM_MODE: 'webhook' }).TELEGRAM_MODE).toBe('webhook');
  });
});

describe('parseEnv telegram production rules', () => {
  const prod = { ...prodBase, TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_BOT_USERNAME: 'otofirsat_bot' };
  it('requires webhook mode with a token in production', () => {
    expect(() => parseEnv(prod)).toThrow(/TELEGRAM_MODE/);
    expect(parseEnv({ ...prod, TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32) }).TELEGRAM_MODE).toBe('webhook');
    expect(parseEnv(prodBase).TELEGRAM_MODE).toBe('polling');
  });
  it('requires an https API base in production', () => {
    const ok = { ...prod, TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32) };
    expect(() => parseEnv({ ...ok, TELEGRAM_API_BASE: 'http://127.0.0.1:9' })).toThrow(/TELEGRAM_API_BASE/);
    expect(parseEnv({ ...ok, TELEGRAM_API_BASE: 'https://example.com' }).TELEGRAM_API_BASE).toBe('https://example.com');
    expect(parseEnv({ ...base, TELEGRAM_API_BASE: 'http://127.0.0.1:9' }).TELEGRAM_API_BASE).toBe('http://127.0.0.1:9');
  });
});
