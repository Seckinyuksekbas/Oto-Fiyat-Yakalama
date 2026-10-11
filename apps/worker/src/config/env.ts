import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ROLE: z.enum(['worker', 'scheduler']).default('worker'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'base64 kodlu 32 bayt olmalı'),
    /** Bot User-Agent'ında yayınlanan iletişim adresi (kaynak sahipleri bize ulaşabilsin). */
    BOT_CONTACT_URL: z.string().url().optional(),
    SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).default(15_000),
    /** Alarm izlemesi (MonitorService) en fazla bu aralıkla çalışır; scheduler tick'inden bağımsız. */
    MONITOR_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
    SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    ANALYZE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    MATCH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    NOTIFY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
    PUBLIC_BASE_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.TELEGRAM_API_BASE.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TELEGRAM_API_BASE'], message: 'production ortamında https olmalı' });
    }
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'];
    for (const key of ['BOT_CONTACT_URL', 'PUBLIC_BASE_URL'] as const) {
      const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      const value = env[key];
      if (!value) fail('production ortamında açıkça ayarlanmalı');
      else if (local.includes(new URL(value).hostname)) fail('production ortamında localhost olamaz');
    }
  })
  .transform((env) => ({ ...env, BOT_CONTACT_URL: env.BOT_CONTACT_URL ?? 'http://localhost:3000/bot', PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? 'http://localhost:3000' }));
export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
