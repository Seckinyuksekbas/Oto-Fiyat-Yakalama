import { describe, expect, it } from 'vitest';
import { safeNextPath, stripRetryFlag, withRetryFlag } from './session';

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
    ['\t/evil', '/app'],
    ['/\n/evil', '/app'],
    ['/app\x7f', '/app'],
    ['%2F%2Fevil.com', '/app'],
    ['/%5Cevil', '/app'],
    [' /app', '/app'],
    ['/giris', '/app'],
    ['/api/x', '/app'],
    ['/application', '/app'],
    ['/app/../giris', '/app'],
    ['/app', '/app'],
    ['/app/ilan/1#x', '/app/ilan/1#x'],
    ['\t/evil', '/app'],
    ['/\n/evil', '/app'],
    ['/app\x7f', '/app'],
    ['%2F%2Fevil.com', '/app'],
    ['/%5Cevil', '/app'],
    [' /app', '/app'],
    ['/giris', '/app'],
    ['/api/x', '/app'],
    ['/application', '/app'],
    ['/app/../giris', '/app'],
    ['/app', '/app'],
    ['/app/ilan/1#x', '/app/ilan/1#x'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('retry flag', () => {
  it('adds and strips _r', () => {
    expect(withRetryFlag('/app/x')).toBe('/app/x?_r=1');
    expect(withRetryFlag('/app/x?a=1')).toBe('/app/x?a=1&_r=1');
    expect(stripRetryFlag('/app/x?a=1&_r=1')).toBe('/app/x?a=1');
    expect(stripRetryFlag('/app/x?_r=1')).toBe('/app/x');
    expect(stripRetryFlag('/app/x')).toBe('/app/x');
  });
});

describe('retry flag', () => {
  it('adds and strips _r', () => {
    expect(withRetryFlag('/app/x')).toBe('/app/x?_r=1');
    expect(withRetryFlag('/app/x?a=1')).toBe('/app/x?a=1&_r=1');
    expect(stripRetryFlag('/app/x?a=1&_r=1')).toBe('/app/x?a=1');
    expect(stripRetryFlag('/app/x?_r=1')).toBe('/app/x');
    expect(stripRetryFlag('/app/x')).toBe('/app/x');
  });
});
