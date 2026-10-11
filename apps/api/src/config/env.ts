import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const pem = (kind: 'private' | 'public') =>
  z
    .string()
    .min(1)
    .transform((v) => v.replace(/\\n/g, '\n'))
    .refine((v) => {
      try {
        if (kind === 'private') createPrivateKey(v);
        else createPublicKey(v);
        return true;
      } catch {
        return false;
      }
    }, kind === 'private' ? 'geçerli bir PKCS8 PEM özel anahtarı olmalı' : 'geçerli bir SPKI PEM açık anahtarı olmalı');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost') || /^127\./.test(h);
}

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: pem('private'),
  JWT_PUBLIC_KEY: pem('public'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'base64 kodlu 32 bayt olmalı'),
  PUBLIC_BASE_URL: z.string().url(),
  COOKIE_SECURE: bool.default('true'),
  /** Önümüzdeki güvenilir ters vekil sayısı (Express `trust proxy`); 0 = hiçbiri. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  MAIL_TRANSPORT: z.enum(['smtp', 'json']).default('smtp'),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_FROM: z.string().default('Oto Fırsat <no-reply@localhost>'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  /** true: bağlantı baştan TLS (genelde 465). false: düz bağlantı + STARTTLS (587). */
  SMTP_SECURE: bool.default('false'),
  /** STARTTLS zorunlu; production'da varsayılan true, diğer ortamlarda false. */
  SMTP_REQUIRE_TLS: bool.optional(),
  HIBP_ENABLED: bool.default('false'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
  /** Proxy sağlık kontrolü hedefi */
  PROXY_CHECK_URL: z.string().url().default('https://www.gstatic.com/generate_204'),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
});

export const envSchema = baseSchema
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_BOT_USERNAME) {
      fail('TELEGRAM_BOT_USERNAME', 'TELEGRAM_BOT_TOKEN varken zorunlu');
    }
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_SECRET) {
      fail('TELEGRAM_WEBHOOK_SECRET', 'webhook modunda zorunlu (32-256 karakter)');
    }
    if (env.SMTP_USER && !env.SMTP_PASS) fail('SMTP_PASS', 'SMTP_USER varken zorunlu');
    if (env.SMTP_PASS && !env.SMTP_USER) fail('SMTP_USER', 'SMTP_PASS varken zorunlu');

    if (env.NODE_ENV !== 'production') return;
    if (env.TELEGRAM_BOT_TOKEN) {
      if (env.TELEGRAM_MODE !== 'webhook') fail('TELEGRAM_MODE', "production ortamında 'webhook' olmalı");
      if (!env.TELEGRAM_API_BASE.startsWith('https://')) fail('TELEGRAM_API_BASE', 'production ortamında https olmalı');
    }
    if (!env.COOKIE_SECURE) fail('COOKIE_SECURE', 'production ortamında true olmalı');
    const base = URL.canParse(env.PUBLIC_BASE_URL) ? new URL(env.PUBLIC_BASE_URL) : null;
    if (base && base.protocol !== 'https:') fail('PUBLIC_BASE_URL', 'production ortamında https olmalı');
    if (base && isLoopbackHost(base.hostname)) fail('PUBLIC_BASE_URL', 'production ortamında localhost/loopback olamaz');
    if (env.MAIL_TRANSPORT !== 'smtp') fail('MAIL_TRANSPORT', "production ortamında 'smtp' olmalı");
    if (isLoopbackHost(env.SMTP_HOST)) fail('SMTP_HOST', 'production ortamında localhost/loopback olamaz (açıkça ayarlayın)');
  })
  .transform((env) => ({ ...env, SMTP_REQUIRE_TLS: env.SMTP_REQUIRE_TLS ?? env.NODE_ENV === 'production' }));
export type Env = z.infer<typeof envSchema>;

/** Sorun mesajı: değişken adı + neden. Değer asla yazdırılmaz (zod'un enum mesajı alınan değeri içerir). */
function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === 'invalid_enum_value') return `şunlardan biri olmalı: ${issue.options.join(' | ')}`;
  if (issue.code === 'invalid_type' && issue.received === 'undefined') return 'zorunlu';
  return issue.message;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${describeIssue(i)}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
