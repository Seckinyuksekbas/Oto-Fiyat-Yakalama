import type { ZodErrorMap } from 'zod';
import { ApiError } from './api';

const GENERIC = 'Bir sorun oluştu. Lütfen biraz sonra tekrar deneyin.';

const CODE_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'E-posta veya şifre hatalı',
  LOGIN_LOCKED: 'Çok sayıda hatalı deneme nedeniyle hesabınız geçici olarak kilitlendi. Biraz bekleyip tekrar deneyin.',
  ACCOUNT_SUSPENDED: 'Hesabınız askıya alınmış. Destek ile iletişime geçin.',
  EMAIL_TAKEN: 'Bu e-posta adresiyle bir hesap zaten var. Giriş yapmayı deneyin.',
  WEAK_PASSWORD: 'Bu şifre çok kolay tahmin edilebilir. Daha uzun ve benzersiz bir şifre seçin.',
  RATE_LIMITED: 'Çok fazla deneme yaptınız. Biraz bekleyip tekrar deneyin.',
  TOKEN_INVALID: 'Bağlantı geçersiz veya süresi dolmuş. Yeni bir bağlantı isteyin.',
  EMAIL_NOT_VERIFIED: 'Devam etmek için e-posta adresinizi doğrulayın.',
  CSRF_REJECTED: 'İstek doğrulanamadı. Sayfayı yenileyip tekrar deneyin.',
  VALIDATION_FAILED: 'Girdiğiniz bilgileri kontrol edin.',
};

export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return CODE_MESSAGES[err.code] ?? GENERIC;
  return 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.';
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
