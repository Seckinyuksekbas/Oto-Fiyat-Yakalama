import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { QueueName, type AnalyzeJobData, type ScrapeJobData } from '@oto/shared';
import { Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  readonly scrape: Queue<ScrapeJobData>;
  readonly analyze: Queue<AnalyzeJobData>;

  constructor(@Inject(ENV) env: Env) {
    const connection = bullConnection(env.REDIS_URL);
    this.scrape = new Queue<ScrapeJobData>(QueueName.SCRAPE, { connection });
    this.analyze = new Queue<AnalyzeJobData>(QueueName.ANALYZE, { connection });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.scrape.close(), this.analyze.close()]);
  }
}
