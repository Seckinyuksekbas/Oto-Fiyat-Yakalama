import { describe, expect, it } from 'vitest';
import { sanitizeLogContext } from './logs.service';

describe('sanitizeLogContext', () => {
  it('redacts secret-looking keys at any depth and masks URL queries in strings', () => {
    const out = sanitizeLogContext({
      token: 'x',
      botToken: 'y',
      Authorization: 'Bearer z',
      chatId: 42,
      apiKey: 'k',
      password: 'p',
      cookie: 'c',
      urlEncrypted: 'e',
      list: [{ secret: 's', url: 'http://h/p?a=1' }, 'see https://h/q?t=2 now'],
      safe: { n: 1, s: 'ok', b: true, nil: null },
    });
    expect(out).toEqual({
      token: '[gizli]',
      botToken: '[gizli]',
      Authorization: '[gizli]',
      chatId: '[gizli]',
      apiKey: '[gizli]',
      password: '[gizli]',
      cookie: '[gizli]',
      urlEncrypted: '[gizli]',
      list: [{ secret: '[gizli]', url: 'http://h/p?…' }, 'see https://h/q?… now'],
      safe: { n: 1, s: 'ok', b: true, nil: null },
    });
  });

  it('passes through null and primitives; caps depth', () => {
    expect(sanitizeLogContext(null)).toBeNull();
    expect(sanitizeLogContext(3)).toBe(3);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(sanitizeLogContext(deep))).toContain('[derin]');
  });
});
