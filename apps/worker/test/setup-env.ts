import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { inject } from 'vitest';

/** Worker'ın varsayılan concurrency'si için gereken havuz (connection_limit guard'ı testlerde uyarı basmasın). */
function withConnectionLimit(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '26');
  return parsed.toString();
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ROLE: 'worker',
  DATABASE_URL: withConnectionLimit(inject('databaseUrl')),
  REDIS_URL: inject('redisUrl'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  // Token biçimli literal yazılmaz (gizli bilgi tarayıcıları); çalışma anında üretilir.
  TELEGRAM_BOT_TOKEN: ['123456789', 'TEST'.padEnd(35, 'x')].join(':'),
  BOT_CONTACT_URL: 'http://localhost:3000/bot',
});

Logger.overrideLogger(false);
