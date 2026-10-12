import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { jsonBody } from './common/json-body';
import { ENV } from './config/config.module';
import type { Env } from './config/env';

/**
 * main.ts ve testler aynı oluşturma seçeneklerini kullanır. `forceCloseConnections`: kapanışta açık keep-alive/SSE soketleri
 * kapatılır (SSE akışları önce ShutdownSignal ile düzgün biter); aksi halde server.close() açık bağlantıları bekler ve
 * SIGTERM sonrası süreç SIGKILL'e kadar asılı kalır.
 */
export const APP_OPTIONS = { bodyParser: false, forceCloseConnections: true } as const satisfies NestApplicationOptions;

/** main.ts ve testler aynı yapılandırmayı kullanır. App `APP_OPTIONS` ile oluşturulmalıdır. */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', app.get<Env>(ENV).TRUST_PROXY);
  app.use(helmet());
  app.use(cookieParser());
  app.use(jsonBody('100kb'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
