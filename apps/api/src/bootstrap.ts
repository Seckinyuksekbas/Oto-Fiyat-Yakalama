import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { jsonBody } from './common/json-body';

/** main.ts ve testler aynı yapılandırmayı kullanır. App `bodyParser: false` ile oluşturulmalıdır. */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.use(jsonBody('100kb'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
