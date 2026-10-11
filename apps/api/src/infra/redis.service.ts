import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

@Injectable()
export class RedisService extends Redis implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 3 });
    this.on('error', (err: Error) => this.logger.error(`Redis hatası: ${err.message}`));
  }

  /** HTTP sunucusu kapandıktan sonra (SSE akışları ShutdownSignal ile bitmiş olur). */
  async onApplicationShutdown(): Promise<void> {
    await this.quit();
  }
}
