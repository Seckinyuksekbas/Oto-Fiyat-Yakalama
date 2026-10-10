import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6380',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('worker env', () => {
  it('applies defaults', () => {
    expect(parseEnv(base)).toMatchObject({ ROLE: 'worker', SCHEDULER_TICK_MS: 15_000, SCRAPE_CONCURRENCY: 2, BOT_CONTACT_URL: 'http://localhost:3000/bot' });
    expect(parseEnv(base).ANALYZE_CONCURRENCY).toBe(4);
  });

  it('bounds ANALYZE_CONCURRENCY', () => {
    expect(() => parseEnv({ ...base, ANALYZE_CONCURRENCY: '0' })).toThrow(/ANALYZE_CONCURRENCY/);
    expect(parseEnv({ ...base, ANALYZE_CONCURRENCY: '8' }).ANALYZE_CONCURRENCY).toBe(8);
  });

  it('rejects an unknown role and missing variables', () => {
    expect(() => parseEnv({ ...base, ROLE: 'boss' })).toThrow(/ROLE/);
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  describe('BOT_CONTACT_URL in production', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    it('must be set explicitly', () => {
      expect(() => parseEnv(prod)).toThrow(/BOT_CONTACT_URL/);
    });
    it('must not point at localhost', () => {
      expect(() => parseEnv({ ...prod, BOT_CONTACT_URL: 'http://localhost:3000/bot' })).toThrow(/BOT_CONTACT_URL/);
      expect(() => parseEnv({ ...prod, BOT_CONTACT_URL: 'http://127.0.0.1/bot' })).toThrow(/BOT_CONTACT_URL/);
    });
    it('accepts a real URL', () => {
      expect(parseEnv({ ...prod, BOT_CONTACT_URL: 'https://oto.example/bot' }).BOT_CONTACT_URL).toBe('https://oto.example/bot');
    });
    it('still defaults in development', () => {
      expect(parseEnv({ ...base, NODE_ENV: 'development' }).BOT_CONTACT_URL).toBe('http://localhost:3000/bot');
    });
  });
});
