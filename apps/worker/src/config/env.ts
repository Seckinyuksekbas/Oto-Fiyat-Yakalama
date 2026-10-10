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
    SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    ANALYZE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BOT_CONTACT_URL'], message });
    if (!env.BOT_CONTACT_URL) return fail('production ortamında açıkça ayarlanmalı');
    const host = new URL(env.BOT_CONTACT_URL).hostname;
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host))
      fail('production ortamında localhost olamaz');
  })
  .transform((env) => ({ ...env, BOT_CONTACT_URL: env.BOT_CONTACT_URL ?? 'http://localhost:3000/bot' }));
export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
