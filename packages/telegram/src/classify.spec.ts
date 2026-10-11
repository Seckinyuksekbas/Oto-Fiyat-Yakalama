import { describe, expect, it } from 'vitest';
import { TelegramApiError } from './client';
import { classifyTelegramError, isPhotoFallbackError } from './classify';

const api = (status: number, description: string, retryAfterSec: number | null = null) =>
  new TelegramApiError('sendMessage', status, status, description, retryAfterSec);

describe('classifyTelegramError', () => {
  it('429 is retryable with retry_after', () => {
    expect(classifyTelegramError(api(429, 'Too Many Requests: retry after 7', 7))).toMatchObject({ kind: 'RETRYABLE', retryAfterMs: 7000 });
  });
  it('5xx and network errors are retryable', () => {
    expect(classifyTelegramError(api(502, 'Bad Gateway')).kind).toBe('RETRYABLE');
    expect(classifyTelegramError(new TypeError('fetch failed')).kind).toBe('RETRYABLE');
    expect(classifyTelegramError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })).kind).toBe('RETRYABLE');
  });
  it('blocked bot / chat not found are permanent and disable the channel', () => {
    expect(classifyTelegramError(api(403, 'Forbidden: bot was blocked by the user'))).toMatchObject({ kind: 'PERMANENT', disableChannel: true });
    expect(classifyTelegramError(api(403, 'Forbidden: user is deactivated'))).toMatchObject({ kind: 'PERMANENT', disableChannel: true });
    expect(classifyTelegramError(api(400, 'Bad Request: chat not found'))).toMatchObject({ kind: 'PERMANENT', disableChannel: true });
  });
  it('other 4xx are permanent without disabling', () => {
    expect(classifyTelegramError(api(400, "Bad Request: can't parse entities"))).toMatchObject({ kind: 'PERMANENT', disableChannel: false });
    expect(classifyTelegramError(api(401, 'Unauthorized'))).toMatchObject({ kind: 'PERMANENT', disableChannel: false });
  });
  it('photo fallback detection', () => {
    expect(isPhotoFallbackError(new TelegramApiError('sendPhoto', 400, 400, 'Bad Request: wrong file identifier/HTTP URL specified', null))).toBe(true);
    expect(isPhotoFallbackError(new TelegramApiError('sendPhoto', 400, 400, 'Bad Request: failed to get HTTP URL content', null))).toBe(true);
    expect(isPhotoFallbackError(api(400, 'Bad Request: chat not found'))).toBe(false);
  });

  it('429 without retry_after defaults to 5s; invalid JSON 200 is retryable; caption too long falls back', () => {
    expect(classifyTelegramError(api(429, 'x', null))).toMatchObject({ retryAfterMs: 5000 });
    expect(classifyTelegramError(api(429, 'x', 0))).toMatchObject({ retryAfterMs: 5000 });
    expect(classifyTelegramError(api(200, 'Geçersiz JSON yanıtı')).kind).toBe('RETRYABLE');
    expect(isPhotoFallbackError(new TelegramApiError('sendPhoto', 400, 400, 'Bad Request: message caption is too long', null))).toBe(true);
  });
});
