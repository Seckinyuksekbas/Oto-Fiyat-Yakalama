import { describe, expect, it } from 'vitest';
import { buildLink } from './links';

describe('buildLink', () => {
  it('handles trailing slashes and encodes the token', () => {
    expect(buildLink('http://x.test/', '/verify-email', 'a-b_c')).toBe('http://x.test/verify-email?token=a-b_c');
    expect(buildLink('http://x.test', '/reset-password', 'a+b')).toBe('http://x.test/reset-password?token=a%2Bb');
  });
});
