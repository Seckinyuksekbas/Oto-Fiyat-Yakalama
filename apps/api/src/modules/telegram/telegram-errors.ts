import { Prisma } from '@oto/db';

/**
 * Aynı Telegram güncellemesi en fazla bu kadar denenir (webhook: Telegram yeniden teslimi; polling: yerel yeniden deneme).
 * Sonra güncelleme atlanır ve SystemLog'a ERROR yazılır; zehirli bir güncelleme kuyruğu kilitlemez.
 */
export const HANDLER_MAX_ATTEMPTS = 5;

/** Bağlantı / zaman aşımı / kilit çakışması: yeniden denemek anlamlı olan Prisma kodları. */
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);

/**
 * Geçici DB hatası mı? true → yeniden fırlat (webhook 500, Telegram yeniden dener).
 * false → kalıcı (doğrulama hatası, geçici küme dışındaki Prisma kodları, Prisma dışı hatalar): yeniden denemek aynı sonucu verir.
 */
export function isTransientDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_PRISMA_CODES.has(err.code);
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientValidationError) return false;
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return TRANSIENT_NET_CODES.has((err as { code: string }).code);
  }
  return false;
}

/** Log/SystemLog için gizli bilgi içermeyen kısa hata tanımı (mesaj değil, yalnızca tür ve kod). */
export function errorKind(err: unknown): { name: string; code?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const code = err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
  return code ? { name, code } : { name };
}
