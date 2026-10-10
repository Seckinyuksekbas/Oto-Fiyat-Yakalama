import { TelegramApiError } from './client';

export type TelegramErrorClass =
  | { kind: 'RETRYABLE'; retryAfterMs?: number; error: string }
  | { kind: 'PERMANENT'; disableChannel: boolean; error: string };

const DISABLE_PATTERNS = [/bot was blocked/i, /user is deactivated/i, /chat not found/i, /bot was kicked/i];

export function classifyTelegramError(err: unknown): TelegramErrorClass {
  if (err instanceof TelegramApiError) {
    const error = err.message;
    if (err.status === 429) return { kind: 'RETRYABLE', retryAfterMs: (err.retryAfterSec ?? 1) * 1000, error };
    if (err.status >= 500) return { kind: 'RETRYABLE', error };
    const disable = (err.status === 403 || err.status === 400) && DISABLE_PATTERNS.some((p) => p.test(err.description));
    return { kind: 'PERMANENT', disableChannel: disable, error };
  }
  // Ağ hatası, zaman aşımı, DNS: geçici
  return { kind: 'RETRYABLE', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
}

const PHOTO_FALLBACK = [/wrong file identifier/i, /failed to get HTTP URL content/i, /wrong type of the web page content/i, /IMAGE_PROCESS_FAILED/i];

export function isPhotoFallbackError(err: unknown): boolean {
  return err instanceof TelegramApiError && err.status === 400 && PHOTO_FALLBACK.some((p) => p.test(err.description));
}
