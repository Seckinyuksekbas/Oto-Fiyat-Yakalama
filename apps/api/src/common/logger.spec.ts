import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './logger';

describe('log redaction', () => {
  it('masks secrets anywhere one level deep and in request headers', () => {
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({
      body: { password: 'hunter2hunter2', token: 'abc', chatId: '42' },
      req: { headers: { cookie: 'access_token=x', authorization: 'Bearer y' } },
    });
    expect(out).not.toMatch(/hunter2|access_token=x|Bearer y|"abc"|"42"/);
    expect(out).toContain('[redacted]');
  });

  it('masks top-level and two-level-deep secrets', () => {
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({ password: 'topsecret1', data: { user: { newPassword: 'deepsecret2', refreshToken: 'rt-3' } } });
    expect(out).not.toMatch(/topsecret1|deepsecret2|rt-3/);
  });
});
