import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
