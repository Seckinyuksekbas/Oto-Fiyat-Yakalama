export interface BullConnectionOptions {
  /** Worker'lar için null (engelleyici komutlar); üreticiler için küçük bir sayı (hızlı hata). */
  maxRetriesPerRequest?: number | null;
  enableOfflineQueue?: boolean;
}

export interface BullConnection {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
  db: number;
  maxRetriesPerRequest: number | null;
  enableOfflineQueue?: boolean;
  tls?: Record<string, never>;
}

/** Redis URL'sinden BullMQ/ioredis bağlantı seçenekleri; rediss: TLS, kullanıcı/şifre URL-çözümlü. */
export function bullConnection(redisUrl: string, opts: BullConnectionOptions = {}): BullConnection {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: opts.maxRetriesPerRequest === undefined ? null : opts.maxRetriesPerRequest,
    ...(opts.enableOfflineQueue === undefined ? {} : { enableOfflineQueue: opts.enableOfflineQueue }),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
