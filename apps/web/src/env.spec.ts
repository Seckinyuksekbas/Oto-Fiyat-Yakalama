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
});
