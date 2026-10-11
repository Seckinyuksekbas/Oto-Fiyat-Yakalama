import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { matchJobSchema, QueueName, type MatchJobData } from '@oto/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import { closeWithTimeout } from '../common/close-with-timeout';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';
import { MatchService } from '../matching/match.service';

export const MATCH_WORKER_AUTOSTART = Symbol('MATCH_WORKER_AUTOSTART');

@Injectable()
export class MatchWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchWorkerHost.name);
  private worker?: Worker<MatchJobData>;

  constructor(
    private readonly matching: MatchService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(MATCH_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<MatchJobData>(
      QueueName.MATCH,
      async (job) => {
        const parsed = matchJobSchema.safeParse(job.data);
        // Bozuk payload kalıcı hatadır; yeniden denemek anlamsız.
        if (!parsed.success) throw new UnrecoverableError(`Geçersiz eşleştirme işi: ${parsed.error.message}`);
        await this.matching.process(parsed.data);
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: this.env.MATCH_CONCURRENCY },
    );
    this.worker.on('error', (err) => this.logger.error(`Eşleştirme worker hatası: ${err.message}`));
    this.worker.on('failed', (job, err) => this.logger.warn(`Eşleştirme işi ${job?.id} başarısız (deneme ${job?.attemptsMade}): ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await closeWithTimeout(this.worker, this.env.SHUTDOWN_TIMEOUT_MS, this.logger);
    this.worker = undefined;
  }
}
