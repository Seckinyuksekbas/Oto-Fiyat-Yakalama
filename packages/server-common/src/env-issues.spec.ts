import { describe, expect, it } from 'vitest';
import { formatEnvIssues, isLoopbackHost, urlHostIsLoopback } from './env-issues';

describe('formatEnvIssues', () => {
  it('names the variable and never echoes an enum value', () => {
    const msg = formatEnvIssues([
      { code: 'invalid_enum_value', path: ['MAIL_TRANSPORT'], message: "Invalid enum value. Expected 'smtp' | 'json', received 's3cr3t'", options: ['smtp', 'json'], received: 's3cr3t' },
      { code: 'invalid_type', path: ['DATABASE_URL'], message: 'Required', received: 'undefined' },
      { code: 'custom', path: ['COOKIE_SECURE'], message: 'production ortamında true olmalı' },
    ]);
    expect(msg).toBe(
      'Invalid environment: MAIL_TRANSPORT: şunlardan biri olmalı: smtp | json; DATABASE_URL: zorunlu; COOKIE_SECURE: production ortamında true olmalı',
    );
    expect(msg).not.toContain('s3cr3t');
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::', '[::]', '0.0.0.0', '::ffff:127.0.0.1', '[::ffff:7f00:1]'])(
    'treats %s as loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(['oto.example', 'smtp.example.com', '10.0.0.1', '128.0.0.1', '::ffff:8.8.8.8'])('treats %s as non-loopback', (h) =>
    expect(isLoopbackHost(h)).toBe(false),
  );
  it('parses URLs (WHATWG normalizes mapped IPv4)', () => {
    expect(urlHostIsLoopback('https://[::ffff:127.0.0.1]/')).toBe(true);
    expect(urlHostIsLoopback('https://[::]/')).toBe(true);
    expect(urlHostIsLoopback('https://oto.example')).toBe(false);
    expect(urlHostIsLoopback('not a url')).toBeNull();
  });
});
