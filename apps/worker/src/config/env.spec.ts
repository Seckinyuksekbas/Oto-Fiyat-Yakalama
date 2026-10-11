import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from './env';

const DB_NO_LIMIT = 'postgresql://u:p@localhost:5433/db';
const base = {
  // Production kuralları connection_limit ister (varsayılan: 2+4+4+8 + NOTIFY_TELEGRAM 5 + 3 = 26)
  DATABASE_URL: `${DB_NO_LIMIT}?connection_limit=26`,
  REDIS_URL: 'redis://localhost:6380',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('worker env', () => {
  it('applies defaults', () => {
    expect(parseEnv(base)).toMatchObject({ ROLE: 'worker', SCHEDULER_TICK_MS: 15_000, SCRAPE_CONCURRENCY: 2, BOT_CONTACT_URL: 'http://localhost:3000/bot' });
    expect(parseEnv(base).ANALYZE_CONCURRENCY).toBe(4);
    expect(parseEnv(base).MATCH_CONCURRENCY).toBe(4);
  });

  it('defaults SHUTDOWN_TIMEOUT_MS to 30000 and bounds it (max 38000: +5 s force close +2 s connection teardown within compose grace 45 s)', () => {
    expect(parseEnv(base).SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    expect(parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '5000' }).SHUTDOWN_TIMEOUT_MS).toBe(5000);
    expect(() => parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    expect(parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '38000' }).SHUTDOWN_TIMEOUT_MS).toBe(38_000);
    expect(() => parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '38001' })).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    expect(() => parseEnv({ ...base, SHUTDOWN_TIMEOUT_MS: '40000' })).toThrow(/SHUTDOWN_TIMEOUT_MS/);
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

  describe('DATABASE_URL connection_limit', () => {
    const prodOk = { ...base, NODE_ENV: 'production', BOT_CONTACT_URL: 'https://oto.example/bot', PUBLIC_BASE_URL: 'https://oto.example' };
    // Varsayılan: 2+4+4+8 + NOTIFY_TELEGRAM 5 = 23 → gereken en az 26
    const withLimit = (n: string) => `${DB_NO_LIMIT}?schema=public&connection_limit=${n}`;

    it('fails in production when connection_limit is missing, without echoing the URL or password', () => {
      let message = '';
      try {
        parseEnv({ ...prodOk, DATABASE_URL: DB_NO_LIMIT }, () => undefined);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/DATABASE_URL: .*connection_limit/);
      expect(message).not.toContain('u:p@');
      expect(message).not.toContain('localhost:5433');
    });

    it('fails in production when connection_limit is below the concurrency sum + 3', () => {
      expect(() => parseEnv({ ...prodOk, DATABASE_URL: withLimit('5') }, () => undefined)).toThrow(/DATABASE_URL: .*connection_limit.*26.*NOTIFY_TELEGRAM/);
      expect(() => parseEnv({ ...prodOk, DATABASE_URL: withLimit('25') }, () => undefined)).toThrow(/connection_limit/);
      expect(() => parseEnv({ ...prodOk, DATABASE_URL: withLimit('abc') }, () => undefined)).toThrow(/connection_limit/);
      expect(parseEnv({ ...prodOk, DATABASE_URL: withLimit('26') }, () => undefined).NODE_ENV).toBe('production');
    });

    it('accounts for configured concurrency', () => {
      const env = { ...prodOk, DATABASE_URL: withLimit('26'), NOTIFY_CONCURRENCY: '9' };
      expect(() => parseEnv(env, () => undefined)).toThrow(/connection_limit.*27/);
    });

    it('is role-aware: the scheduler only needs 3 connections', () => {
      const scheduler = { ...prodOk, ROLE: 'scheduler' };
      expect(parseEnv({ ...scheduler, DATABASE_URL: withLimit('3') }, () => undefined).ROLE).toBe('scheduler');
      expect(() => parseEnv({ ...scheduler, DATABASE_URL: withLimit('2') }, () => undefined)).toThrow(/connection_limit.*en az 3.*ROLE=scheduler/);
      expect(() => parseEnv({ ...scheduler, DATABASE_URL: DB_NO_LIMIT }, () => undefined)).toThrow(/connection_limit/);
    });

    it('reports an unparseable DATABASE_URL without echoing it', () => {
      const secret = 'p#ss';
      let message = '';
      try {
        parseEnv({ ...prodOk, DATABASE_URL: `postgresql://u:${secret}@db/oto?connection_limit=26` }, () => undefined);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/DATABASE_URL: .*ayrıştırılamadı \(parolayı percent-encode edin\)/);
      expect(message).not.toContain(secret);
    });

    it('only warns in development and test', () => {
      for (const NODE_ENV of ['development', 'test']) {
        const warn = vi.fn();
        expect(parseEnv({ ...base, NODE_ENV, DATABASE_URL: DB_NO_LIMIT }, warn).NODE_ENV).toBe(NODE_ENV);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/connection_limit/);
        expect(warn.mock.calls[0][0]).not.toContain('u:p@');
        const quiet = vi.fn();
        parseEnv({ ...base, NODE_ENV, DATABASE_URL: withLimit('26') }, quiet);
        expect(quiet).not.toHaveBeenCalled();
      }
    });
  });
});
