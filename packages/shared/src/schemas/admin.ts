import { z } from 'zod';
import { planLimitsSchema } from '../plan';
import { analysisSettingsPatchSchema } from './analysis-settings';

/** LIKE/ILIKE desenlerinde `\`, `%` ve `_` karakterlerini kaçışlar. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** URL sorgu dizisini `?…` ile maskeler; geçersiz URL için sabit metin döner. */
export function maskUrlQuery(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '[geçersiz URL]';
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?…` : base;
  } catch {
    return '[geçersiz URL]';
  }
}

const adminPageShape = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
export const adminPageQuery = z.object(adminPageShape);

const isoDate = z.string().datetime();
const intId = z.coerce.number().int().min(1).max(2_147_483_647);
const text = (max = 100) => z.string().trim().min(1).max(max);

export const adminUsersQuerySchema = z
  .object({
    q: text().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
    role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']).optional(),
    plan: z.string().trim().min(1).max(20).optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

export const adminListingsQuerySchema = z
  .object({
    source: intId.optional(),
    make: text().optional(),
    model: text().optional(),
    status: z.enum(['ACTIVE', 'REMOVED']).optional(),
    hasIssues: z.enum(['true', 'false']).optional(),
    q: text().optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminListingsQuery = z.infer<typeof adminListingsQuerySchema>;

export const adminListingIssuesQuerySchema = z
  .object({ source: intId.optional(), field: text().optional(), ...adminPageShape })
  .strict();
export type AdminListingIssuesQuery = z.infer<typeof adminListingIssuesQuerySchema>;

export const adminAnalysesQuerySchema = z
  .object({
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT']).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    engineVersion: text(50).optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminAnalysesQuery = z.infer<typeof adminAnalysesQuerySchema>;

export const adminJobsQuerySchema = z
  .object({
    source: intId.optional(),
    status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL']).optional(),
    trigger: z.enum(['SCHEDULED', 'MANUAL']).optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminJobsQuery = z.infer<typeof adminJobsQuerySchema>;

export const adminNotificationsQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED_LIMIT']).optional(),
    channel: z.enum(['IN_APP', 'TELEGRAM', 'EMAIL']).optional(),
    kind: text(50).optional(),
    userId: text(50).optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminNotificationsQuery = z.infer<typeof adminNotificationsQuerySchema>;

export const adminAuditLogsQuerySchema = z
  .object({
    action: text(100).optional(),
    actorId: text(50).optional(),
    targetType: text(50).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminAuditLogsQuery = z.infer<typeof adminAuditLogsQuerySchema>;

export const adminSystemLogsQuerySchema = z
  .object({
    level: z.enum(['WARN', 'ERROR']).optional(),
    component: text(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...adminPageShape,
  })
  .strict();
export type AdminSystemLogsQuery = z.infer<typeof adminSystemLogsQuerySchema>;

// ---- Gövde şemaları ----

export const adminUpdateUserSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export type AdminUpdateUser = z.infer<typeof adminUpdateUserSchema>;

export const adminRoleSchema = z.object({ role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']) }).strict();
export type AdminRole = z.infer<typeof adminRoleSchema>;

const inAppRequired = (channels: string[]) => channels.includes('IN_APP');
const inAppMessage = { message: 'IN_APP kanalı çıkarılamaz' };

export const adminSubscriptionSchema = z
  .object({
    planId: z.string().min(1).max(50),
    endsAt: isoDate.nullable(),
    limitOverrides: planLimitsSchema
      .partial()
      .strict()
      .refine((o) => o.channels === undefined || inAppRequired(o.channels), {
        ...inAppMessage,
        path: ['channels'],
      })
      .nullable(),
  })
  .strict();
export type AdminSubscription = z.infer<typeof adminSubscriptionSchema>;

const sourceConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: 'yalnızca http(s)' }),
  })
  .passthrough()
  .refine((c) => new TextEncoder().encode(JSON.stringify(c)).length <= 4096, { message: 'config 4 KB sınırını aşıyor' });

const sourceFields = {
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(1).max(100),
  adapterKey: z.string().trim().min(1).max(100),
  kind: z.enum(['HTTP', 'BROWSER', 'API', 'FEED']),
  permissionType: z.enum(['LICENSED_API', 'PARTNER_FEED', 'TOS_PERMITTED', 'TEST']),
  permissionNote: z.string().trim().max(500),
  permissionVerified: z.boolean().optional(),
  intervalSec: z.number().int().min(60).max(86400),
  maxConcurrency: z.number().int().min(1).max(8),
  minRequestGapMs: z.number().int().min(500).max(60000),
  config: sourceConfigSchema,
  proxyConfigId: z.number().int().min(1).nullable(),
};

export const adminSourceCreateSchema = z.object(sourceFields).strict();
export type AdminSourceCreate = z.infer<typeof adminSourceCreateSchema>;

export const adminSourceUpdateSchema = z.object(sourceFields).omit({ code: true }).partial().strict();
export type AdminSourceUpdate = z.infer<typeof adminSourceUpdateSchema>;

export const adminTestScrapeSchema = z.object({ dryRun: z.boolean() }).strict();
export type AdminTestScrape = z.infer<typeof adminTestScrapeSchema>;

const proxyUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'yalnızca http(s) proxy URL' });
const proxyFields = {
  name: z.string().trim().min(1).max(100),
  url: proxyUrl,
  isEnabled: z.boolean(),
};
export const adminProxyCreateSchema = z.object(proxyFields).strict();
export type AdminProxyCreate = z.infer<typeof adminProxyCreateSchema>;
export const adminProxyUpdateSchema = z.object(proxyFields).partial().strict();
export type AdminProxyUpdate = z.infer<typeof adminProxyUpdateSchema>;

export const adminQueueNameSchema = z.enum(['scrape', 'analyze', 'match', 'notify', 'notify-telegram']);
export type AdminQueueName = z.infer<typeof adminQueueNameSchema>;

export const adminQueueCleanSchema = z
  .object({
    state: z.enum(['completed', 'failed']),
    olderThanSec: z.number().int().min(3600),
  })
  .strict();
export type AdminQueueClean = z.infer<typeof adminQueueCleanSchema>;

export const adminNotificationRetrySchema = z
  .object({ ids: z.array(z.number().int().min(1)).min(1).max(100) })
  .strict();
export type AdminNotificationRetry = z.infer<typeof adminNotificationRetrySchema>;

const planFields = {
  code: z.string().regex(/^[A-Z0-9_]{2,20}$/),
  name: z.string().trim().min(1).max(100),
  priceMonthly: z.number().min(0),
  isActive: z.boolean(),
  limits: planLimitsSchema.refine((l) => inAppRequired(l.channels), {
    ...inAppMessage,
    path: ['channels'],
  }),
};
export const adminPlanCreateSchema = z.object(planFields).strict();
export type AdminPlanCreate = z.infer<typeof adminPlanCreateSchema>;
export const adminPlanUpdateSchema = z.object(planFields).omit({ code: true }).partial().strict();
export type AdminPlanUpdate = z.infer<typeof adminPlanUpdateSchema>;

export const alertThresholdsSchema = z
  .object({
    notifyQueueDepth: z.number().int().min(1).max(1_000_000).default(500),
    notifyFailureRate: z.number().min(0).max(1).default(0.1),
    parserErrorRate: z.number().min(0).max(1).default(0.2),
    heartbeatMissSec: z.number().int().min(10).max(3600).default(60),
  })
  .strict();
export type AlertThresholds = z.infer<typeof alertThresholdsSchema>;
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = alertThresholdsSchema.parse({});

export const settingKeySchema = z.enum(['analysis.settings', 'alerts.thresholds']);
export type SettingKey = z.infer<typeof settingKeySchema>;

export const adminSettingsPatchSchema = z.object({ key: settingKeySchema, value: z.unknown() }).strict();
export type AdminSettingsPatch = z.infer<typeof adminSettingsPatchSchema>;

export type ParsedSetting =
  | { ok: true; value: unknown }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] };

/** Ayar değerini anahtara özel şemayla doğrular. analysis.settings kısmi geçersiz kılmadır (varsayılanlarla birleşince çapraz kurallar sağlanmalı). */
export function parseSettingValue(key: SettingKey, value: unknown): ParsedSetting {
  const schema = key === 'analysis.settings' ? analysisSettingsPatchSchema : alertThresholdsSchema.partial().strict();
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path, message: i.message })) };
}
