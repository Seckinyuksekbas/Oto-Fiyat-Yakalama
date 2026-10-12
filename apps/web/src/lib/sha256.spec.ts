import { createHash } from 'node:crypto';
import { sha256, toBase64 } from './sha256';

describe('sha256 (pure JS)', () => {
  it.each([
    ['empty', ''],
    ['short', 'abc'],
    ['padding boundary 55', 'a'.repeat(55)],
    ['padding boundary 56', 'a'.repeat(56)],
    ['exact block', 'a'.repeat(64)],
    ['multi block', 'x'.repeat(1000)],
    ['utf-8', 'Oto Fırsat — ğüşiöç'],
  ])('matches node:crypto (%s)', (_label, input) => {
    const expected = createHash('sha256').update(input, 'utf8').digest('base64');
    expect(toBase64(sha256(input))).toBe(expected);
  });
});
