import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@oto/db';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(ENV) env: Env) {
    super({ datasources: { db: { url: env.DATABASE_URL } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** HTTP sunucusu kapandıktan sonra (SSE akışları ShutdownSignal ile bitmiş olur). */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
