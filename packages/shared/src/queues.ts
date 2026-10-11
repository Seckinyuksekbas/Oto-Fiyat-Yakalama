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

/**
 * Yeniden denenen işler (worker + API ortak): 5 deneme, üstel bekleme. `removeOnComplete: true` nedeniyle iş tamamlanınca
 * silinir; jobId yalnızca beklerken/çalışırken sorgulanabilir (tamamlandıktan sonra getJob(jobId) null döner).
 */
export const RETRYING_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};

/**
 * Bildirim işleri (worker dağıtıcısı + admin yeniden denemesi ortak): 5 deneme; başarısızlar 7 gün tutulur (admin yeniden
 * deneyebilir); bekleme süreleri worker'daki notifyBackoffMs (özel strateji) ile belirlenir.
 */
export const NOTIFY_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'custom' as const },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/**
 * Tarama işleri (zamanlayıcı + admin test taraması ortak): yeniden deneme yok (iş kendi içinde nazik yeniden dener);
 * tamamlananlar 24 saat, başarısızlar 7 gün tutulur.
 */
/** Tarama kuyruğu iş kimliği (CollectionJob başına tek iş). */
export function scrapeQueueJobId(collectionJobId: number): string {
  return `scrape-${collectionJobId}`;
}

export const SCRAPE_JOB_OPTS = {
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/** Eşleştirme olayı yeniden gönderim sınırı: bu kadar başarısız denemeden sonra süpürme satırı atlar (admin sıfırlayabilir). */
export const MATCH_DISPATCH_MAX_ATTEMPTS = 10;
/**
 * "Takılı" eşleştirme gönderimi (Prisma `ListingAnalysisWhereInput` ile yapısal uyumlu): olay var, kuyruğa alınmamış,
 * deneme sınırına ulaşmış. Worker analiz süpürmesi (alarm) ve admin API (liste/sıfırlama) aynı tanımı kullanır.
 */
export const MATCH_DISPATCH_STUCK_WHERE: {
  matchEvent: { in: Array<'NEW' | 'PRICE_DROP' | 'RELIST'> };
  matchQueuedAt: null;
  matchDispatchAttempts: { gte: number };
} = {
  matchEvent: { in: ['NEW', 'PRICE_DROP', 'RELIST'] },
  matchQueuedAt: null,
  matchDispatchAttempts: { gte: MATCH_DISPATCH_MAX_ATTEMPTS },
};
/** Takılı eşleştirme alarmının "bir kez" işareti (Redis); admin sayacı sıfırlayınca silinir ki yinelenirse yeniden alarm verilsin. */
export function matchDispatchStuckFlagKey(analysisId: number): string {
  return `match-dispatch-stuck:alerted:${analysisId}`;
}

export const scrapeJobSchema = z.object({
  collectionJobId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
});
export type ScrapeJobData = z.infer<typeof scrapeJobSchema>;

/** İpucu niteliğindedir: tüketici asıl olayı DB durumundan türetir. REFRESH = gece yeniden analizi; MANUAL = admin yeniden analizi (maddi değişiklik kontrolünü atlar). */
export const analyzeReasonSchema = z.enum(['NEW', 'PRICE_CHANGE', 'RELIST', 'UPDATE', 'REFRESH', 'MANUAL']);
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
