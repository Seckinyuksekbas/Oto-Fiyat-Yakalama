import { formatEnvIssues, urlHostIsLoopback } from '@oto/server-common';
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
    /**
     * Kapanışta aktif işlerin bitmesi için beklenen süre; aşılırsa worker zorla kapatılır.
     * En fazla 40 sn: zorla kapatma payı (5 sn) eklenince compose `stop_grace_period: 45s` içinde kalır (aksi halde SIGKILL).
     */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(40_000).default(30_000),
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
    const poolProblem = connectionLimitProblem(env);
    if (poolProblem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: poolProblem });
    if (!env.TELEGRAM_API_BASE.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['TELEGRAM_API_BASE'], message: 'production ortamında https olmalı' });
    }
    for (const key of ['BOT_CONTACT_URL', 'PUBLIC_BASE_URL'] as const) {
      const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      const value = env[key];
      // Geçersiz URL'yi alanın kendi .url() kuralı zaten bildirir; burada yalnız ayrıştırılabilenler denetlenir
      if (!value) fail('production ortamında açıkça ayarlanmalı');
      else if (urlHostIsLoopback(value)) fail('production ortamında localhost/loopback olamaz');
    }
  })
  .transform((env) => ({ ...env, BOT_CONTACT_URL: env.BOT_CONTACT_URL ?? 'http://localhost:3000/bot', PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? 'http://localhost:3000' }));
export type Env = z.infer<typeof envSchema>;

/** `notify-telegram` kuyruğunun sabit paralelliği (Bot API hız sınırı ayrıca limiter ile uygulanır). */
export const NOTIFY_TELEGRAM_CONCURRENCY = 5;
/** Her süreçte iş dışı kullanım payı (sweep/heartbeat/alarm sorguları). */
const POOL_HEADROOM = 3;

type PoolInputs = Pick<Env, 'ROLE' | 'DATABASE_URL' | 'SCRAPE_CONCURRENCY' | 'ANALYZE_CONCURRENCY' | 'MATCH_CONCURRENCY' | 'NOTIFY_CONCURRENCY'>;

/**
 * Prisma havuzunda gereken en az bağlantı. Worker: her eşzamanlı iş bir bağlantı tutar
 * (SCRAPE+ANALYZE+MATCH+NOTIFY+NOTIFY_TELEGRAM) + 3 pay. Scheduler kuyruk tüketmez: yalnız 3 pay.
 */
export function requiredConnectionLimit(env: Omit<PoolInputs, 'DATABASE_URL'>): number {
  if (env.ROLE === 'scheduler') return POOL_HEADROOM;
  return env.SCRAPE_CONCURRENCY + env.ANALYZE_CONCURRENCY + env.MATCH_CONCURRENCY + env.NOTIFY_CONCURRENCY + NOTIFY_TELEGRAM_CONCURRENCY + POOL_HEADROOM;
}

const formulaFor = (role: Env['ROLE']) =>
  role === 'scheduler' ? 'ROLE=scheduler için 3' : `SCRAPE+ANALYZE+MATCH+NOTIFY_CONCURRENCY + NOTIFY_TELEGRAM(${NOTIFY_TELEGRAM_CONCURRENCY}) + 3`;

/**
 * `DATABASE_URL` sorgu dizgisindeki `connection_limit` yetersizse nedenini döndürür (yoksa `null`).
 * Mesaj URL'yi ya da parolayı asla içermez; yalnız değişken adı, kural ve gereken en az değer.
 */
export function connectionLimitProblem(env: PoolInputs): string | null {
  const min = requiredConnectionLimit(env);
  const rule = `en az ${min} olmalı (${formulaFor(env.ROLE)})`;
  if (!URL.canParse(env.DATABASE_URL)) return `ayrıştırılamadı (parolayı percent-encode edin); connection_limit ${rule}`;
  const raw = new URL(env.DATABASE_URL).searchParams.get('connection_limit');
  if (raw === null) return `connection_limit sorgu parametresi eksik; ${rule}`;
  if (!/^\d+$/.test(raw)) return `connection_limit pozitif tamsayı olmalı; ${rule}`;
  if (Number(raw) < min) return `connection_limit ${rule}`;
  return null;
}

/**
 * Production'da eksik/yetersiz `connection_limit` açılışı durdurur (superRefine); development/test'te yalnız uyarır,
 * çünkü yerel Prisma varsayılan havuzu (num_cpus*2+1) genelde yeterlidir.
 */
export function parseEnv(source: Record<string, string | undefined>, warn: (message: string) => void = console.warn): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new Error(formatEnvIssues(result.error.issues));
  if (result.data.NODE_ENV !== 'production') {
    const poolProblem = connectionLimitProblem(result.data);
    if (poolProblem) warn(`Uyarı (DATABASE_URL): ${poolProblem}; production'da worker bu durumda başlamaz`);
  }
  return result.data;
}
