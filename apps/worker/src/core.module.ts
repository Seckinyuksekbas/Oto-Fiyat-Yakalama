import { Global, Module } from '@nestjs/common';
import { Encryptor, REDACT_PATHS } from '@oto/server-common';
import { LoggerModule } from 'nestjs-pino';
import { AlertService } from './common/alert.service';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env';
import { PrismaService } from './infra/prisma.service';
import { RedisService } from './infra/redis.service';
import { NotificationDispatcher } from './notifications/notification-dispatcher';
import { QueueRegistry } from './queues/queue-registry';

@Global()
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: { paths: REDACT_PATHS, censor: '[redacted]' },
          transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
        },
      }),
    }),
  ],
  providers: [
    PrismaService,
    RedisService,
    QueueRegistry,
    AlertService,
    // Global: AlertService (core) ve bildirim/eşleştirme modülleri aynı dağıtıcıyı kullanır; bağımlılıkları yalnızca core.
    NotificationDispatcher,
    { provide: Encryptor, inject: [ENV], useFactory: (env: Env) => new Encryptor(env.DATA_ENCRYPTION_KEY) },
  ],
  exports: [PrismaService, RedisService, QueueRegistry, AlertService, NotificationDispatcher, Encryptor],
})
export class CoreModule {}
