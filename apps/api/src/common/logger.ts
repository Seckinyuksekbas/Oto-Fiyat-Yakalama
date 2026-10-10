import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { REDACT_PATHS } from '@oto/server-common';
import type { Env } from '../config/env';

export { REDACT_PATHS };

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
