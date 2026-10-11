import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { inject } from 'vitest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ROLE: 'worker',
  DATABASE_URL: inject('databaseUrl'),
  REDIS_URL: inject('redisUrl'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  TELEGRAM_BOT_TOKEN: '123456:test-token',
  BOT_CONTACT_URL: 'http://localhost:3000/bot',
});

Logger.overrideLogger(false);
