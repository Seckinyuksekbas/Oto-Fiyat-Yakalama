import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ErrorCode, type ApiErrorBody } from '@oto/shared';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

const HTTP_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  429: ErrorCode.RATE_LIMITED,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: unknown }>();
    const { status, body } = this.toBody(exception, String(req.id ?? ''));
    res.status(status).json(body);
  }

  private toBody(exception: unknown, requestId: string): { status: number; body: ApiErrorBody } {
    if (exception instanceof AppError) {
      const error: ApiErrorBody['error'] = { code: exception.code, message: exception.message };
      if (exception.details !== undefined) error.details = exception.details;
      return { status: exception.status, body: { error } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL : ErrorCode.VALIDATION_FAILED);
      const message = status === 404 ? 'Kayıt bulunamadı' : exception.message;
      return { status, body: { error: { code, message } } };
    }
    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    return {
      status: 500,
      body: { error: { code: ErrorCode.INTERNAL, message: 'Beklenmeyen bir hata oluştu', details: { requestId } } },
    };
  }
}
