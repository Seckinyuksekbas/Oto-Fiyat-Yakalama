import { describe, expect, it } from 'vitest';
import { generateToken, hashToken } from './tokens';

describe('tokens', () => {
  it('generates 43-char base64url tokens for 32 bytes, all unique', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
    for (const t of set) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex chars', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});
