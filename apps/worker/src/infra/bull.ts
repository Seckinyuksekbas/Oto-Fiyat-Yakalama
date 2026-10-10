import type { ConnectionOptions } from 'bullmq';

/** BullMQ worker'ları engelleyici komut kullandığından maxRetriesPerRequest null olmalıdır. */
export function bullConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}
