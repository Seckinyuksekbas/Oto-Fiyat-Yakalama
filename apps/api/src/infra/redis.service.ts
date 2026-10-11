import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 3 });
    this.on('error', (err: Error) => this.logger.error(`Redis hatası: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
