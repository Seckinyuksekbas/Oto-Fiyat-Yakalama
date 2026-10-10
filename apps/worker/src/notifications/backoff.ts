const SCHEDULE = [10_000, 30_000, 120_000, 600_000, 1_800_000];

export class RetryableNotifyError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableNotifyError';
  }
}

/** BullMQ özel backoff stratejisi: attemptsMade = şimdiye kadar başarısız deneme sayısı (≥1). */
export function notifyBackoffMs(attemptsMade: number, err?: unknown): number {
  const base = SCHEDULE[Math.min(Math.max(attemptsMade, 1), SCHEDULE.length) - 1];
  const hint = err instanceof RetryableNotifyError ? (err.retryAfterMs ?? 0) : 0;
  return Math.max(base, hint);
}
