import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { ErrorCode, type ApiErrorBody } from '@oto/shared';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

/**
 * Geçici DB yoğunluğu: lock_timeout, statement_timeout (bkz. infra/tx-options), deadlock (40P01) ve
 * serileştirme çakışması (40001). Hepsi yeniden denenebilir; istemciye 503 + Retry-After döner.
 */
const BUSY_PG_CODES = new Set(['55P03', '57014', '40P01', '40001']);
const BUSY_PG_MESSAGE = /code: [`"](55P03|57014|40P01|40001)[`"]/i;
const RETRY_AFTER_SEC = '5';

/**
 * Prisma'nın "sistem meşgul" hataları (gerçek biçimler Prisma 6.19 ile doğrulandı):
 * - P2028: interaktif tx maxWait/timeout aşıldı.
 * - P2024: havuzdan bağlantı alınamadı.
 * - P2034: yazma çakışması / deadlock (Prisma'nın model sorgularında 40001/40P01 karşılığı).
 * - P2010 (ham sorgu) + meta.code 55P03/57014/40P01/40001; meta yoksa mesajdaki `Code: \`55P03\``.
 * - Model sorgusu: PrismaClientUnknownRequestError, PG kodu yalnız mesajda (`code: "55P03"`).
 */
export function isServiceBusy(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2028' || e.code === 'P2024' || e.code === 'P2034') return true;
    if (e.code !== 'P2010') return false;
    const pg = (e.meta as { code?: unknown } | undefined)?.code;
    return typeof pg === 'string' ? BUSY_PG_CODES.has(pg) : BUSY_PG_MESSAGE.test(e.message);
  }
  return e instanceof Prisma.PrismaClientUnknownRequestError && BUSY_PG_MESSAGE.test(e.message);
}

const HTTP_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.INVALID_OPERATION,
  429: ErrorCode.RATE_LIMITED,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: unknown }>();
    const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const { status, body } = this.toBody(exception, String(req.id ?? ''), route);
    if (body.error.code === ErrorCode.SERVICE_BUSY) res.setHeader('Retry-After', RETRY_AFTER_SEC);
    res.status(status).json(body);
  }

  private toBody(exception: unknown, requestId: string, route: string): { status: number; body: ApiErrorBody } {
    if (exception instanceof AppError) {
      const error: ApiErrorBody['error'] = { code: exception.code, message: exception.message };
      if (exception.details !== undefined) error.details = exception.details;
      return { status: exception.status, body: { error } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL : ErrorCode.VALIDATION_FAILED);
      const message =
        status >= 500 ? 'Beklenmeyen bir hata oluştu' : status === 404 ? 'Kayıt bulunamadı' : exception.message;
      return { status, body: { error: { code, message } } };
    }
    if (isServiceBusy(exception)) {
      // Kilit/havuz/transaction zaman aşımı: geçici durum; iç ayrıntı yanıta yazılmaz.
      const prismaCode = exception instanceof Prisma.PrismaClientKnownRequestError ? exception.code : 'UNKNOWN';
      this.logger.warn({ requestId, route, prismaCode }, 'Service busy (DB lock/pool/tx timeout)');
      return {
        status: 503,
        body: { error: { code: ErrorCode.SERVICE_BUSY, message: 'Sistem şu anda yoğun, lütfen biraz sonra tekrar deneyin' } },
      };
    }
    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    return {
      status: 500,
      body: { error: { code: ErrorCode.INTERNAL, message: 'Beklenmeyen bir hata oluştu', details: { requestId } } },
    };
  }
}
