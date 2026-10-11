import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { analyzeJobSchema, QueueName, type AnalyzeJobData } from '@oto/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import { AnalysisLockBusyError, AnalysisService } from '../analysis/analysis.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

export const ANALYZE_WORKER_AUTOSTART = Symbol('ANALYZE_WORKER_AUTOSTART');

@Injectable()
export class AnalyzeWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyzeWorkerHost.name);
  private worker?: Worker<AnalyzeJobData>;

  constructor(
    private readonly analysis: AnalysisService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(ANALYZE_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<AnalyzeJobData>(
      QueueName.ANALYZE,
      async (job) => {
        const parsed = analyzeJobSchema.safeParse(job.data);
        // Bozuk payload kalıcı hatadır; yeniden denemek anlamsız.
        if (!parsed.success) throw new UnrecoverableError(`Geçersiz analiz işi: ${parsed.error.message}`);
        await this.analysis.process(parsed.data.listingId);
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: this.env.ANALYZE_CONCURRENCY },
    );
    this.worker.on('error', (err) => this.logger.error(`Analiz worker hatası: ${err.message}`));
    this.worker.on('failed', (job, err) => {
      // Kilit meşgulü beklenen bir yarıştır; iş geri çekilmeyle yeniden denenir.
      const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
      if (!exhausted && (err instanceof AnalysisLockBusyError || err.name === 'AnalysisLockBusyError')) {
        this.logger.debug(`Analiz işi ${job?.id} kilit nedeniyle ertelendi (deneme ${job?.attemptsMade})`);
        return;
      }
      this.logger.warn(`Analiz işi ${job?.id} başarısız (deneme ${job?.attemptsMade}): ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
