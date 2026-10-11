import type { ZodErrorMap } from 'zod';
import { ErrorCode } from '@oto/shared';
import { ApiError } from './api';

const GENERIC = 'Bir sorun oluştu. Lütfen biraz sonra tekrar deneyin.';

const CODE_MESSAGES: Record<string, string> = {
  [ErrorCode.INVALID_CREDENTIALS]: 'E-posta veya şifre hatalı',
  [ErrorCode.LOGIN_LOCKED]: 'Çok sayıda hatalı deneme nedeniyle hesabınız geçici olarak kilitlendi. Biraz bekleyip tekrar deneyin.',
  [ErrorCode.ACCOUNT_SUSPENDED]: 'Hesabınız askıya alınmış. Destek ile iletişime geçin.',
  [ErrorCode.EMAIL_TAKEN]: 'Bu e-posta adresiyle bir hesap zaten var. Giriş yapmayı deneyin.',
  [ErrorCode.WEAK_PASSWORD]: 'Bu şifre çok kolay tahmin edilebilir. Daha uzun ve benzersiz bir şifre seçin.',
  [ErrorCode.RATE_LIMITED]: 'Çok fazla deneme yaptınız. Biraz bekleyip tekrar deneyin.',
  [ErrorCode.TOKEN_INVALID]: 'Bağlantı geçersiz veya süresi dolmuş. Yeni bir bağlantı isteyin.',
  [ErrorCode.EMAIL_NOT_VERIFIED]: 'Devam etmek için e-posta adresinizi doğrulayın.',
  [ErrorCode.CSRF_REJECTED]: 'İstek doğrulanamadı. Sayfayı yenileyip tekrar deneyin.',
  [ErrorCode.VALIDATION_FAILED]: 'Girdiğiniz bilgileri kontrol edin.',
};

export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return CODE_MESSAGES[err.code] ?? GENERIC;
  return NETWORK_MESSAGE;
}

/** zod varsayılan İngilizce mesajlarını Türkçe'ye çevirir. */
export const trErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case 'invalid_type':
      return { message: issue.received === 'undefined' ? 'Bu alan zorunlu' : 'Geçersiz değer' };
    case 'invalid_literal':
      return { message: 'Devam etmek için onay vermeniz gerekir' };
    case 'invalid_string':
      return { message: issue.validation === 'email' ? 'Geçerli bir e-posta adresi girin' : 'Geçersiz değer' };
    case 'too_small':
      return { message: issue.minimum === 1 ? 'Bu alan zorunlu' : `En az ${String(issue.minimum)} karakter olmalı` };
    case 'too_big':
      return { message: `En fazla ${String(issue.maximum)} karakter olabilir` };
    default:
      return { message: ctx.defaultError };
  }
};

export const RATE_LIMIT_MESSAGE = 'Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.';
export const NETWORK_MESSAGE = 'Bağlantı hatası. İnternet bağlantınızı kontrol edip tekrar deneyin.';

/**
 * Hesap varlığını sızdırmayan akışlar (şifremi unuttum, doğrulama yeniden gönder) için:
 * yalnızca hız sınırı ve ağ hatası ayrı gösterilir; diğer her sonuç "başarılı" sayılır.
 */
export function leakSafeFailure(err: unknown): string | null {
  if (err instanceof ApiError) {
    return err.status === 429 || err.code === ErrorCode.RATE_LIMITED ? RATE_LIMIT_MESSAGE : null;
  }
  return NETWORK_MESSAGE;
}
