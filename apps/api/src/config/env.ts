import { createPrivateKey, createPublicKey } from 'node:crypto';
import { formatEnvIssues, isLoopbackHost, urlHostIsLoopback } from '@oto/server-common';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const pem = (kind: 'private' | 'public') =>
  z
    .string()
    .min(1)
    .transform((v) => v.replace(/\\n/g, '\n'))
    .refine(
      (v) => {
        try {
          const key = kind === 'private' ? createPrivateKey(v) : createPublicKey(v);
          return key.asymmetricKeyType === 'ed25519';
        } catch {
          return false;
        }
      },
      kind === 'private' ? 'Ed25519 PKCS8 PEM özel anahtarı olmalı' : 'Ed25519 SPKI PEM açık anahtarı olmalı',
    );

/** "Ad <adres@alan>" ya da "adres@alan" biçiminden alan adını çıkarır. */
function mailDomain(from: string): string | null {
  const addr = (/<([^<>]+)>\s*$/.exec(from)?.[1] ?? from).trim();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  return addr.slice(at + 1);
}

const MAILPIT_PORT = 1025;

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
  /** Verilmezse geliştirmede Mailpit (1025); production'da açıkça verilmeli. */
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SMTP_FROM: z.string().default('Oto Fırsat <no-reply@localhost>'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  /** true: bağlantı baştan TLS (genelde 465). false: düz bağlantı + STARTTLS (587). */
  SMTP_SECURE: bool.default('false'),
  /** STARTTLS zorunlu; production'da varsayılan true, diğer ortamlarda false. */
  SMTP_REQUIRE_TLS: bool.optional(),
  /** HaveIBeenPwned kontrolü; verilmezse production'da true, diğer ortamlarda false. */
  HIBP_ENABLED: bool.optional(),
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
    if (env.SMTP_SECURE && env.SMTP_PORT === 587) fail('SMTP_SECURE', "587 portu STARTTLS kullanır; SMTP_SECURE=false olmalı");
    if (!env.SMTP_SECURE && env.SMTP_PORT === 465) fail('SMTP_SECURE', '465 portu doğrudan TLS kullanır; SMTP_SECURE=true olmalı');

    if (env.NODE_ENV !== 'production') return;
    if (env.TELEGRAM_BOT_TOKEN) {
      if (env.TELEGRAM_MODE !== 'webhook') fail('TELEGRAM_MODE', "production ortamında 'webhook' olmalı");
      if (!env.TELEGRAM_API_BASE.startsWith('https://')) fail('TELEGRAM_API_BASE', 'production ortamında https olmalı');
    }
    if (!env.COOKIE_SECURE) fail('COOKIE_SECURE', 'production ortamında true olmalı');
    if (URL.canParse(env.PUBLIC_BASE_URL) && new URL(env.PUBLIC_BASE_URL).protocol !== 'https:') {
      fail('PUBLIC_BASE_URL', 'production ortamında https olmalı');
    }
    if (urlHostIsLoopback(env.PUBLIC_BASE_URL)) fail('PUBLIC_BASE_URL', 'production ortamında localhost/loopback olamaz');
    if (env.MAIL_TRANSPORT !== 'smtp') fail('MAIL_TRANSPORT', "production ortamında 'smtp' olmalı");
    if (isLoopbackHost(env.SMTP_HOST)) fail('SMTP_HOST', 'production ortamında localhost/loopback olamaz (açıkça ayarlayın)');
    if (env.SMTP_PORT === undefined) fail('SMTP_PORT', 'production ortamında açıkça ayarlanmalı (587 STARTTLS ya da 465 TLS)');
    else if (env.SMTP_PORT === MAILPIT_PORT) fail('SMTP_PORT', 'production ortamında 1025 (Mailpit) olamaz');
    const domain = mailDomain(env.SMTP_FROM);
    if (!domain) fail('SMTP_FROM', 'geçerli bir gönderen adresi içermeli');
    else if (isLoopbackHost(domain)) fail('SMTP_FROM', 'production ortamında gönderen alan adı localhost/loopback olamaz');
    const requireTls = env.SMTP_REQUIRE_TLS ?? true;
    if (env.SMTP_USER && !env.SMTP_SECURE && !requireTls) {
      fail('SMTP_REQUIRE_TLS', 'SMTP kimlik bilgileri şifresiz gönderilemez: SMTP_SECURE=true ya da SMTP_REQUIRE_TLS=true olmalı');
    }
  })
  .transform((env) => {
    const prod = env.NODE_ENV === 'production';
    return {
      ...env,
      SMTP_PORT: env.SMTP_PORT ?? MAILPIT_PORT,
      SMTP_REQUIRE_TLS: env.SMTP_REQUIRE_TLS ?? prod,
      HIBP_ENABLED: env.HIBP_ENABLED ?? prod,
    };
  });
export type Env = z.infer<typeof envSchema>;

/** Hata mesajı değişken adını ve nedeni içerir; değer asla yazdırılmaz. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new Error(formatEnvIssues(result.error.issues));
  return result.data;
}
