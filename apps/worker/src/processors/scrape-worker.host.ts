import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { QueueName, scrapeJobSchema, type ScrapeJobData } from '@oto/shared';
import { Worker } from 'bullmq';
import { ScrapeRunner } from '../collection/scrape-runner.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

export const SCRAPE_WORKER_AUTOSTART = Symbol('SCRAPE_WORKER_AUTOSTART');

@Injectable()
export class ScrapeWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapeWorkerHost.name);
  private worker?: Worker<ScrapeJobData>;

  constructor(
    private readonly runner: ScrapeRunner,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(SCRAPE_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<ScrapeJobData>(
      QueueName.SCRAPE,
      async (job) => {
        const data = scrapeJobSchema.parse(job.data);
        await this.runner.run(data.collectionJobId);
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: this.env.SCRAPE_CONCURRENCY },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Scrape işi ${job?.id} başarısız: ${err.message}`));
  }

  /** Graceful shutdown: aktif işler bitene kadar bekler. */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
