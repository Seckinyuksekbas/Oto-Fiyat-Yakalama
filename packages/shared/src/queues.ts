import { z } from 'zod';

/** BullMQ kuyruk adları. `:` içeremez. */
export const QueueName = {
  SCRAPE: 'scrape',
  ANALYZE: 'analyze',
  MATCH: 'match',
  NOTIFY: 'notify',
  NOTIFY_TELEGRAM: 'notify-telegram',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const scrapeJobSchema = z.object({
  collectionJobId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
});
export type ScrapeJobData = z.infer<typeof scrapeJobSchema>;

/** İpucu niteliğindedir: tüketici asıl olayı DB durumundan türetir. REFRESH = gece yeniden analizi. */
export const analyzeReasonSchema = z.enum(['NEW', 'PRICE_CHANGE', 'RELIST', 'UPDATE', 'REFRESH']);
export type AnalyzeReason = z.infer<typeof analyzeReasonSchema>;

export const analyzeJobSchema = z.object({
  listingId: z.number().int().positive(),
  reason: analyzeReasonSchema,
  /** Önceki fiyat (TL, rakam dizgisi) — fiyat değiştiğinde (PRICE_CHANGE veya fiyatı değişmiş RELIST) */
  previousPrice: z.string().regex(/^\d+$/).optional(),
});
export type AnalyzeJobData = z.infer<typeof analyzeJobSchema>;

export const matchEventSchema = z.enum(['NEW', 'PRICE_DROP', 'RELIST']);
export type MatchEvent = z.infer<typeof matchEventSchema>;

/** Plan 04 (eşleştirme) tüketir. Tüketici güncel DB durumunu okumalıdır. */
export const matchJobSchema = z.object({
  listingId: z.number().int().positive(),
  analysisId: z.number().int().positive(),
  event: matchEventSchema,
  /** PRICE_DROP'ta, son analiz edilen fiyat (TL, rakam dizgisi) */
  previousPrice: z.string().regex(/^\d+$/).optional(),
});
export type MatchJobData = z.infer<typeof matchJobSchema>;

export const notifyJobSchema = z.object({ notificationId: z.number().int().positive() });
export type NotifyJobData = z.infer<typeof notifyJobSchema>;
export function notifyJobId(notificationId: number): string {
  return `notify-${notificationId}`;
}
