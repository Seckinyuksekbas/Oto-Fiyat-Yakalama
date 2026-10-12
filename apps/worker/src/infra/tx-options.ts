import type { Prisma } from '@oto/db';

/** Kilit tutan interaktif transaction'lar (API'deki `LOCK_TX_OPTIONS` ile aynı): Prisma varsayılanı 5 sn yük altında yetmez. */
export const LOCK_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * Prisma'nın tx `timeout`'u kilitte bekleyen sorguyu iptal etmez; bu yüzden kilitli tx'in İLK ifadesi olarak çağrılır
 * (SET LOCAL eşdeğeri, tx bitince sıfırlanır): `lock_timeout` 5 sn, `statement_timeout` 12 sn — ikisi de tx timeout'undan kısa.
 */
export async function boundLocks(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '12s', true)`;
}
