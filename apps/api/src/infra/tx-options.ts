/**
 * Advisory kilit tutan interaktif transaction'lar için Prisma seçenekleri.
 * Aşılırsa Prisma P2028 fırlatır; AllExceptionsFilter bunu 503 SERVICE_BUSY'ye çevirir.
 */
export const LOCK_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
