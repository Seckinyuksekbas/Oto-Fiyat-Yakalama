import { describe, expect, it } from 'vitest';
import { maskUrlsInText } from './url-mask';

describe('maskUrlsInText', () => {
  it('masks userinfo of any scheme', () => {
    expect(maskUrlsInText('bağlantı postgres://user:pass@db:5432/app hatası')).toBe('bağlantı postgres://***@db:5432/app hatası');
    expect(maskUrlsInText('redis://:s3cret@cache:6379 kapalı')).toBe('redis://***@cache:6379 kapalı');
  });

  it('masks http(s) query strings and credentials together', () => {
    const out = maskUrlsInText('HTTP 500: https://u:p@x.test/a?token=gizli ve http://y.test/b?c=1');
    expect(out).not.toContain('gizli');
    expect(out).not.toContain('u:p');
    expect(out).toContain('http://y.test/b?…');
  });

  it('leaves plain text and null untouched', () => {
    expect(maskUrlsInText('düz metin a@b')).toBe('düz metin a@b');
    expect(maskUrlsInText(null)).toBeNull();
  });
});
