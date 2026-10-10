import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { inject } from 'vitest';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: inject('databaseUrl'),
  REDIS_URL: inject('redisUrl'),
  JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'false',
  MAIL_TRANSPORT: 'json',
  HIBP_ENABLED: 'false',
});
