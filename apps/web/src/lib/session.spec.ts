import { describe, expect, it } from 'vitest';
import { safeNextPath } from './session';

describe('safeNextPath', () => {
  it.each([
    ['/app/firsatlar', '/app/firsatlar'],
    ['/app?x=1', '/app?x=1'],
    ['https://kotu.com', '/app'],
    ['//kotu.com', '/app'],
    ['/\\kotu.com', '/app'],
    ['javascript:alert(1)', '/app'],
    ['', '/app'],
    [null, '/app'],
    [undefined, '/app'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
