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
    expect(parseEnv(base).MATCH_CONCURRENCY).toBe(4);
  });

  it('defaults SHUTDOWN_TIMEOUT_MS to 30000 and bounds it', () => {
    expect(parseEnv(base).SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    expect(parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '5000' }).SHUTDOWN_TIMEOUT_MS).toBe(5000);
    expect(() => parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(/SHUTDOWN_TIMEOUT_MS/);
  });

  it('never echoes an invalid value in the error message', () => {
    const marker = randomBytes(12).toString('hex');
    let message = '';
    try {
      parseEnv({ ...base, ROLE: marker });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ROLE: şunlardan biri olmalı: worker \| scheduler/);
    expect(message).not.toContain(marker);
  });

  it('does not crash on an unparseable URL in production', () => {
    const prod = { ...base, NODE_ENV: 'production', BOT_CONTACT_URL: 'not a url', PUBLIC_BASE_URL: 'https://oto.example' };
    expect(() => parseEnv(prod)).toThrow(/Invalid environment: .*BOT_CONTACT_URL/);
  });

  it('rejects IPv4-mapped and unspecified loopback URLs in production', () => {
    const prod = { ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://oto.example' };
    expect(() => parseEnv({ ...prod, BOT_CONTACT_URL: 'https://[::ffff:127.0.0.1]/bot' })).toThrow(/BOT_CONTACT_URL/);
    expect(() => parseEnv({ ...prod, BOT_CONTACT_URL: 'https://[::]/bot' })).toThrow(/BOT_CONTACT_URL/);
  });

  it('bounds ANALYZE_CONCURRENCY', () => {
    expect(() => parseEnv({ ...base, ANALYZE_CONCURRENCY: '0' })).toThrow(/ANALYZE_CONCURRENCY/);
    expect(parseEnv({ ...base, ANALYZE_CONCURRENCY: '8' }).ANALYZE_CONCURRENCY).toBe(8);
  });

  it('bounds MATCH_CONCURRENCY', () => {
    expect(() => parseEnv({ ...base, MATCH_CONCURRENCY: '0' })).toThrow(/MATCH_CONCURRENCY/);
    expect(() => parseEnv({ ...base, MATCH_CONCURRENCY: '33' })).toThrow(/MATCH_CONCURRENCY/);
    expect(parseEnv({ ...base, MATCH_CONCURRENCY: '8' }).MATCH_CONCURRENCY).toBe(8);
  });

  it('bounds NOTIFY_CONCURRENCY and defaults telegram settings', () => {
    expect(parseEnv(base).NOTIFY_CONCURRENCY).toBe(8);
    expect(() => parseEnv({ ...base, NOTIFY_CONCURRENCY: '0' })).toThrow(/NOTIFY_CONCURRENCY/);
    expect(() => parseEnv({ ...base, NOTIFY_CONCURRENCY: '33' })).toThrow(/NOTIFY_CONCURRENCY/);
    expect(parseEnv(base).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(parseEnv(base).TELEGRAM_API_BASE).toBe('https://api.telegram.org');
    expect(parseEnv(base).PUBLIC_BASE_URL).toBe('http://localhost:3000');
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
      expect(parseEnv({ ...prod, BOT_CONTACT_URL: 'https://oto.example/bot', PUBLIC_BASE_URL: 'https://oto.example' }).BOT_CONTACT_URL).toBe('https://oto.example/bot');
    });
    it('requires PUBLIC_BASE_URL explicitly and not localhost', () => {
      const ok = { ...prod, BOT_CONTACT_URL: 'https://oto.example/bot' };
      expect(() => parseEnv(ok)).toThrow(/PUBLIC_BASE_URL/);
      expect(() => parseEnv({ ...ok, PUBLIC_BASE_URL: 'http://localhost:3000' })).toThrow(/PUBLIC_BASE_URL/);
      expect(parseEnv({ ...ok, PUBLIC_BASE_URL: 'https://oto.example' }).PUBLIC_BASE_URL).toBe('https://oto.example');
    });
    it('requires an https TELEGRAM_API_BASE', () => {
      const ok = { ...prod, BOT_CONTACT_URL: 'https://oto.example/bot', PUBLIC_BASE_URL: 'https://oto.example' };
      expect(() => parseEnv({ ...ok, TELEGRAM_API_BASE: 'http://telegram.internal' })).toThrow(/TELEGRAM_API_BASE/);
      expect(parseEnv({ ...ok, TELEGRAM_API_BASE: 'https://telegram.internal' }).TELEGRAM_API_BASE).toBe('https://telegram.internal');
      expect(parseEnv({ ...base, TELEGRAM_API_BASE: 'http://localhost:9999' }).TELEGRAM_API_BASE).toBe('http://localhost:9999');
    });
    it('still defaults in development', () => {
      expect(parseEnv({ ...base, NODE_ENV: 'development' }).BOT_CONTACT_URL).toBe('http://localhost:3000/bot');
    });
  });
});
