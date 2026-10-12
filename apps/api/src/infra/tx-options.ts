import type { Prisma } from '@oto/db';

/**
 * Kilit tutan interaktif transaction'lar için Prisma seçenekleri.
 * Aşılırsa Prisma P2028 fırlatır; AllExceptionsFilter bunu 503 SERVICE_BUSY'ye çevirir.
 */
export const LOCK_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/** Ağır işler (KVKK anonimleştirme): kilit beklemesi yine kısa, ama işin kendisine geniş süre. */
export const HEAVY_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Prisma'nın tx `timeout`'u kilitte bekleyen sorguyu İPTAL ETMEZ: istek asılı kalır ve havuz bağlantısını tutar.
 * Bu yüzden her kilitli tx'in İLK ifadesi olarak çağrılır (SET LOCAL eşdeğeri; tx bitince sıfırlanır):
 * - `lock_timeout` 5 sn → 55P03; `statement_timeout` 12 sn (heavy: 25 sn) → 57014. İkisi de tx timeout'undan kısadır.
 * Hatalar AllExceptionsFilter'da 503 SERVICE_BUSY + Retry-After olur.
 */
export async function boundLocks(tx: Prisma.TransactionClient, kind: 'default' | 'heavy' = 'default'): Promise<void> {
  const statementTimeout = kind === 'heavy' ? '25s' : '12s';
  await tx.$executeRaw`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', ${statementTimeout}, true)`;
}
