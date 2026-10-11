import { z } from 'zod';

const iso = z.string().datetime();

/** Redis pub/sub kanalı: worker alarmları ve iş durumu değişimleri; API admin SSE akışı (`GET /admin/stream`) buna abone olur. */
export const ADMIN_EVENTS_CHANNEL = 'admin:events';

/** Redis pub/sub kanalı: API bir `SystemSetting` değiştirince anahtarı yayınlar; worker'lar ilgili önbelleği geçersiz kılar. */
export const SETTINGS_CHANGED_CHANNEL = 'settings:changed';

/**
 * Worker AlertService'in susturma (dedupe) Redis anahtarı: `alert:<alarm anahtarı>`. API (ör. takılı eşleştirme sıfırlama)
 * aynı anahtarı silerek alarmın yinelenirse yeniden verilmesini sağlar.
 */
export function alertDedupeKey(key: string): string {
  return `alert:${key}`;
}

export const alertLevelSchema = z.enum(['WARN', 'ERROR']);
export type AlertLevel = z.infer<typeof alertLevelSchema>;

export const adminAlertEventSchema = z.object({
  type: z.literal('alert'),
  key: z.string().min(1).max(200),
  level: alertLevelSchema,
  message: z.string().max(4000),
  at: iso,
});

export const adminJobEventSchema = z.object({
  type: z.literal('job'),
  jobId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL']),
  at: iso,
});

export const adminEventSchema = z.discriminatedUnion('type', [adminAlertEventSchema, adminJobEventSchema]);
export type AdminEvent = z.infer<typeof adminEventSchema>;
export type AdminAlertEvent = z.infer<typeof adminAlertEventSchema>;
export type AdminJobEvent = z.infer<typeof adminJobEventSchema>;

/** Adminlere giden SYSTEM_ALERT bildiriminin payload'ı (IN_APP ve TELEGRAM aynı). */
export const systemAlertPayloadSchema = z.object({
  type: z.literal('SYSTEM_ALERT'),
  key: z.string(),
  level: alertLevelSchema,
  message: z.string(),
  at: iso,
});
export type SystemAlertPayload = z.infer<typeof systemAlertPayloadSchema>;
