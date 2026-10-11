import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const pem = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\\n/g, '\n'));

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: pem,
  JWT_PUBLIC_KEY: pem,
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'base64 kodlu 32 bayt olmalı'),
  PUBLIC_BASE_URL: z.string().url(),
  COOKIE_SECURE: bool.default('true'),
  MAIL_TRANSPORT: z.enum(['smtp', 'json']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_FROM: z.string().default('Oto Fırsat <no-reply@localhost>'),
  HIBP_ENABLED: bool.default('false'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
});

export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_USERNAME) {
    ctx.addIssue({ code: 'custom', path: ['TELEGRAM_BOT_USERNAME'], message: 'TELEGRAM_BOT_TOKEN varken zorunlu' });
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'webhook modunda zorunlu (32-256 karakter)' });
  }
  if (env.NODE_ENV === 'production' && env.TELEGRAM_BOT_TOKEN) {
    if (env.TELEGRAM_MODE !== 'webhook') {
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_MODE'], message: "production ortamında 'webhook' olmalı" });
    }
    if (!env.TELEGRAM_API_BASE.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_API_BASE'], message: 'production ortamında https olmalı' });
    }
  }
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
