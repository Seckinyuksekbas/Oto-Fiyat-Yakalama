import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact-secrets';

// Sahte token çalışma anında üretilir (35 karakterlik gizli kısım; tarayıcılar gerçek token sanmasın).
const TOKEN = ['123456789', 'TEST'.padEnd(35, 'x')].join(':');

describe('redactSecrets', () => {
  it('masks a Telegram bot token in the bot<token> URL form', () => {
    const out = redactSecrets(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage (500)`);
    expect(out).not.toContain(TOKEN.split(':')[1]);
    expect(out).not.toContain('123456789:');
    expect(out).toContain('https://api.telegram.org/bot[redacted]/sendMessage');
  });

  it('masks short bot<id>:<secret> forms too', () => {
    expect(redactSecrets('boom bot123:SECRET-tok')).toBe('boom bot[redacted]');
  });

  it('masks a bare token and keeps surrounding text', () => {
    expect(redactSecrets(`token ${TOKEN} invalid`)).toBe('token [redacted] invalid');
  });

  it('masks URL userinfo and query strings', () => {
    const out = redactSecrets('proxy http://user:s3cret@10.0.0.1:8080/x?key=abc&sig=def failed');
    expect(out).toBe('proxy http://***@10.0.0.1:8080/x?… failed');
  });

  it('masks userinfo and query for any scheme, not only http(s)', () => {
    expect(redactSecrets('connect redis://:hunter2@redis:6379/0 failed')).toBe('connect redis://***@redis:6379/0 failed');
    expect(redactSecrets('proxy socks5://u:p4ss@10.0.0.1:1080 refused')).toBe('proxy socks5://***@10.0.0.1:1080 refused');
    expect(redactSecrets('db postgres://app:pw@db/oto?sslmode=require&password=x down')).toBe('db postgres://***@db/oto?… down');
    expect(redactSecrets('amqps://guest:guest@mq/vhost')).toBe('amqps://***@mq/vhost');
  });

  it('leaves ordinary text and short numeric pairs alone', () => {
    expect(redactSecrets('Telegram 429 retry_after 12:30 chat 42')).toBe('Telegram 429 retry_after 12:30 chat 42');
    expect(redactSecrets('USER_INACTIVE')).toBe('USER_INACTIVE');
  });
});
