import { ErrorCode } from '@oto/shared';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError(ErrorCode.VALIDATION_FAILED, 400, 'Geçersiz istek', details),
  unauthenticated: () => new AppError(ErrorCode.UNAUTHENTICATED, 401, 'Oturum açmanız gerekiyor'),
  forbidden: () => new AppError(ErrorCode.FORBIDDEN, 403, 'Bu işlem için yetkiniz yok'),
  notFound: () => new AppError(ErrorCode.NOT_FOUND, 404, 'Kayıt bulunamadı'),
  invalidCredentials: (status = 401) =>
    new AppError(ErrorCode.INVALID_CREDENTIALS, status, 'E-posta veya şifre hatalı'),
};
