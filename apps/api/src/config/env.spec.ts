import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('applies defaults and unescapes PEM newlines', () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(3001);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.HIBP_ENABLED).toBe(false);
    expect(env.JWT_PRIVATE_KEY).toContain('\nabc\n');
  });

  it('fails fast listing every missing variable', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL.*REDIS_URL/s);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => parseEnv({ ...base, DATA_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(
      /DATA_ENCRYPTION_KEY/,
    );
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
