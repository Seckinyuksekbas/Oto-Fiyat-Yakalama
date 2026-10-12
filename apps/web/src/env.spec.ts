import { describe, expect, it } from 'vitest';
import { parseWebEnv } from './env';

describe('parseWebEnv', () => {
  it('defaults API_ORIGIN to the local api', () => {
    expect(parseWebEnv({}).API_ORIGIN).toBe('http://localhost:3001');
  });

  it('accepts a valid origin and strips a trailing slash', () => {
    expect(parseWebEnv({ API_ORIGIN: 'http://api:3001/' }).API_ORIGIN).toBe('http://api:3001');
  });

  it('throws on an invalid API_ORIGIN', () => {
    expect(() => parseWebEnv({ API_ORIGIN: 'not a url' })).toThrow(/API_ORIGIN/);
    expect(() => parseWebEnv({ API_ORIGIN: 'ftp://api:3001' })).toThrow(/API_ORIGIN/);
  });

  it('CSP_IMG_EXTRA is optional and parsed into origins', () => {
    expect(parseWebEnv({}).CSP_IMG_EXTRA).toEqual([]);
    expect(parseWebEnv({ CSP_IMG_EXTRA: 'http://127.0.0.1:4100 https://img.example.com' }).CSP_IMG_EXTRA).toEqual([
      'http://127.0.0.1:4100',
      'https://img.example.com',
    ]);
  });

  it('rejects an invalid CSP_IMG_EXTRA entry without printing the value', () => {
    let message = '';
    try {
      parseWebEnv({ CSP_IMG_EXTRA: 'http://ok.example.com https://x.example.com/hidden-path' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/CSP_IMG_EXTRA/);
    expect(message).not.toContain('hidden-path');
  });
});
