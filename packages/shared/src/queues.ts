import { z } from 'zod';

/** BullMQ kuyruk adları. `:` içeremez. */
export const QueueName = {
  SCRAPE: 'scrape',
  ANALYZE: 'analyze',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const scrapeJobSchema = z.object({
  collectionJobId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
});
export type ScrapeJobData = z.infer<typeof scrapeJobSchema>;

export const analyzeReasonSchema = z.enum(['NEW', 'PRICE_CHANGE', 'RELIST', 'UPDATE']);
export type AnalyzeReason = z.infer<typeof analyzeReasonSchema>;

export const analyzeJobSchema = z.object({
  listingId: z.number().int().positive(),
  reason: analyzeReasonSchema,
  /** Önceki fiyat (TL, rakam dizgisi) — yalnızca PRICE_CHANGE'de */
  previousPrice: z.string().regex(/^\d+$/).optional(),
});
export type AnalyzeJobData = z.infer<typeof analyzeJobSchema>;
