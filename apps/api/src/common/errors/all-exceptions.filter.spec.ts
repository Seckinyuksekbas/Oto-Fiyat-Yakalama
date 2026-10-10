import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, Errors } from './app-error';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ id: 'req-1' }) }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: status.mock.calls[0][0] as number, body: json.mock.calls[0][0] };
}

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('passes AppError code/status/message/details through', () => {
    const { status, body } = run(Errors.validation([{ path: 'a', message: 'bad' }]));
    expect(status).toBe(400);
    expect(body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Geçersiz istek', details: [{ path: 'a', message: 'bad' }] },
    });
  });

  it('omits details when undefined', () => {
    const { status, body } = run(Errors.notFound());
    expect(status).toBe(404);
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Kayıt bulunamadı' } });
    expect('details' in body.error).toBe(false);
  });

  it('maps HttpException 429 to RATE_LIMITED', () => {
    const { status, body } = run(new HttpException('slow down', 429));
    expect(status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('maps HttpException 409 to INVALID_OPERATION', () => {
    const { status, body } = run(new HttpException('conflict', 409));
    expect(status).toBe(409);
    expect(body.error.code).toBe('INVALID_OPERATION');
  });

  it('maps HttpException 503 to INTERNAL with a generic message', () => {
    const { status, body } = run(new HttpException('db host 10.0.0.5 down', 503));
    expect(status).toBe(503);
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('Beklenmeyen bir hata oluştu');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('turns unknown errors into a generic 500 with requestId only', () => {
    const err = new Error('secret connection string postgres://u:p@h');
    const { status, body } = run(err);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu', details: { requestId: 'req-1' } },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('secret');
    expect(text).not.toContain(err.stack ?? 'nostack');
  });

  it('AppError is exported for instanceof use', () => {
    expect(new AppError('NOT_FOUND', 404, 'x')).toBeInstanceOf(Error);
  });
});
