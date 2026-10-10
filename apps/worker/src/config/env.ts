import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ROLE: z.enum(['worker', 'scheduler']).default('worker'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'base64 kodlu 32 bayt olmalı'),
  /** Bot User-Agent'ında yayınlanan iletişim adresi (kaynak sahipleri bize ulaşabilsin). */
  BOT_CONTACT_URL: z.string().url().default('http://localhost:3000/bot'),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).default(15_000),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});
export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
