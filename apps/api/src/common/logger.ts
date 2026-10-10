import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { Env } from '../config/env';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.chatId',
  '*.config',
  '*.proxyUrl',
  '*.urlEncrypted',
];

export function loggerOptions(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      autoLogging: env.NODE_ENV !== 'test',
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      genReqId: (req, res) => {
        const header = req.headers['x-request-id'];
        const id = typeof header === 'string' && /^[\w-]{8,64}$/.test(header) ? header : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
  };
}
