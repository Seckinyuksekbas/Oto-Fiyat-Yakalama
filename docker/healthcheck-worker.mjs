// Worker/scheduler konteyner sağlık denetimi: bu konteynerin (hostname) Redis'te canlı bir heartbeat
// anahtarı var mı? Anahtar biçimi: `worker:heartbeat:<hostname>:<pid>` (TTL 45 sn; bkz.
// apps/worker/src/common/heartbeat.service.ts). KEYS yerine SCAN kullanılır (Redis'i bloklamaz).
import { hostname } from 'node:os';
import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('healthcheck: REDIS_URL tanımlı değil');
  process.exit(1);
}

const redis = new Redis(url, {
  lazyConnect: true,
  connectTimeout: 3000,
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  retryStrategy: () => null,
});
redis.on('error', () => {}); // hata aşağıda ele alınır; ioredis'in işlenmemiş hata uyarısını sustur

const pattern = `worker:heartbeat:${hostname()}:*`;
const timer = setTimeout(() => {
  console.error('healthcheck: zaman aşımı');
  process.exit(1);
}, 5000);

try {
  await redis.connect();
  let cursor = '0';
  let found = false;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    found = keys.length > 0;
  } while (!found && cursor !== '0');
  clearTimeout(timer);
  redis.disconnect();
  if (!found) console.error(`healthcheck: heartbeat yok (${pattern})`);
  process.exit(found ? 0 : 1);
} catch (err) {
  console.error(`healthcheck: Redis hatası: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
