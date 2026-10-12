import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, Errors } from './app-error';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn();
  const req = { id: 'req-1', method: 'POST', path: '/api/v1/me/search-profiles', route: { path: '/api/v1/me/search-profiles' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, setHeader }), getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  const headers = Object.fromEntries(setHeader.mock.calls.map(([k, v]) => [String(k).toLowerCase(), v]));
  return { status: status.mock.calls[0][0] as number, body: json.mock.calls[0][0], headers };
}

/** Gerçek DB koşusundan alınmış biçimler (Prisma 6.19): ham sorgu → P2010 + meta.code; model sorgusu → UnknownRequestError. */
const rawFailed = (pgCode: string, pgMessage: string, withMeta = true) =>
  new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.$executeRaw()\` invocation:


Raw query failed. Code: \`${pgCode}\`. Message: \`ERROR: ${pgMessage}\``,
    { code: 'P2010', clientVersion: '6.19.3', meta: withMeta ? { code: pgCode, message: `ERROR: ${pgMessage}` } : undefined },
  );
const modelFailed = (pgCode: string, pgMessage: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Invalid \`tx.user.update()\` invocation:
Error occurred during query execution:
ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${pgCode}", message: "${pgMessage}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: '6.19.3' },
  );

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

  it('maps Prisma P2028 (interactive transaction timeout) to 503 SERVICE_BUSY', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Transaction already closed: expired after 15000ms', {
      code: 'P2028',
      clientVersion: 'test',
    });
    const { status, body } = run(err);
    expect(status).toBe(503);
    expect(body.error.code).toBe('SERVICE_BUSY');
    expect(JSON.stringify(body)).not.toContain('15000ms');
  });

  it.each([
    ['P2010 lock_timeout (55P03)', () => rawFailed('55P03', 'canceling statement due to lock timeout')],
    ['P2010 statement_timeout (57014)', () => rawFailed('57014', 'canceling statement due to statement timeout')],
    ['P2010 without meta.code (message fallback)', () => rawFailed('55P03', 'canceling statement due to lock timeout', false)],
    ['model query lock_timeout (UnknownRequestError)', () => modelFailed('55P03', 'canceling statement due to lock timeout')],
    ['model query statement_timeout (UnknownRequestError)', () => modelFailed('57014', 'canceling statement due to statement timeout')],
    ['P2024 pool timeout', () => new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool', { code: 'P2024', clientVersion: '6.19.3' })],
    ['P2034 write conflict / deadlock', () => new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock. Please retry your transaction', { code: 'P2034', clientVersion: '6.19.3' })],
    ['P2010 deadlock (40P01)', () => rawFailed('40P01', 'deadlock detected')],
    ['P2010 serialization failure (40001)', () => rawFailed('40001', 'could not serialize access due to concurrent update')],
    ['P2010 deadlock without meta.code (message fallback)', () => rawFailed('40P01', 'deadlock detected', false)],
    ['model query deadlock (UnknownRequestError)', () => modelFailed('40P01', 'deadlock detected')],
    ['model query serialization failure (UnknownRequestError)', () => modelFailed('40001', 'could not serialize access due to concurrent update')],
  ])('maps %s to 503 SERVICE_BUSY with Retry-After and a route-tagged warn', (_name, make) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { status, body, headers } = run(make());
    expect(status).toBe(503);
    expect(body).toEqual({ error: { code: 'SERVICE_BUSY', message: expect.any(String) } });
    expect(JSON.stringify(body)).not.toMatch(/55P03|57014|40P01|40001|timeout|deadlock|ConnectorError/);
    expect(headers['retry-after']).toBe('5');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1', route: 'POST /api/v1/me/search-profiles' }), expect.any(String));
  });

  it('keeps unrelated raw-query and unknown Prisma failures as a generic 500 without Retry-After', () => {
    const unique = run(rawFailed('23505', 'duplicate key value violates unique constraint'));
    expect(unique.status).toBe(500);
    expect(unique.headers['retry-after']).toBeUndefined();
    expect(run(modelFailed('22001', 'value too long for type character varying(10)')).status).toBe(500);
  });

  it('keeps other Prisma known errors as a generic 500', () => {
    const err = new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2002', clientVersion: 'test' });
    expect(run(err).status).toBe(500);
  });

  it('AppError is exported for instanceof use', () => {
    expect(new AppError('NOT_FOUND', 404, 'x')).toBeInstanceOf(Error);
  });
});
