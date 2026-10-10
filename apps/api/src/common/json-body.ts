import express, { type RequestHandler } from 'express';
import { ErrorCode } from '@oto/shared';

/** express.json hatalarını standart hata gövdesine çevirir (Nest filtrelerine ulaşmazlar). */
export function jsonBody(limit: string): RequestHandler {
  const parser = express.json({ limit });
  return (req, res, next) => {
    parser(req, res, (err?: unknown) => {
      if (!err) return next();
      const tooLarge = (err as { status?: number }).status === 413;
      res.status(tooLarge ? 413 : 400).json({
        error: { code: ErrorCode.VALIDATION_FAILED, message: tooLarge ? 'İstek gövdesi çok büyük' : 'Geçersiz JSON' },
      });
    });
  };
}
