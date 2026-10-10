import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { QueueName, type AnalyzeJobData, type MatchJobData, type NotifyJobData, type ScrapeJobData } from '@oto/shared';
import { Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  readonly scrape: Queue<ScrapeJobData>;
  readonly analyze: Queue<AnalyzeJobData>;
  readonly match: Queue<MatchJobData>;
  readonly notify: Queue<NotifyJobData>;
  readonly notifyTelegram: Queue<NotifyJobData>;

  private readonly logger = new Logger(QueueRegistry.name);

  constructor(@Inject(ENV) env: Env) {
    const connection = bullConnection(env.REDIS_URL);
    this.scrape = new Queue<ScrapeJobData>(QueueName.SCRAPE, { connection });
    this.analyze = new Queue<AnalyzeJobData>(QueueName.ANALYZE, { connection });
    this.match = new Queue<MatchJobData>(QueueName.MATCH, { connection });
    this.notify = new Queue<NotifyJobData>(QueueName.NOTIFY, { connection });
    this.notifyTelegram = new Queue<NotifyJobData>(QueueName.NOTIFY_TELEGRAM, { connection });
    this.notify.on('error', (err) => this.logger.error(`notify kuyruğu hatası: ${err.message}`));
    this.notifyTelegram.on('error', (err) => this.logger.error(`notify-telegram kuyruğu hatası: ${err.message}`));
    this.match.on('error', (err) => this.logger.error(`match kuyruğu hatası: ${err.message}`));
    this.scrape.on('error', (err) => this.logger.error(`scrape kuyruğu hatası: ${err.message}`));
    this.analyze.on('error', (err) => this.logger.error(`analyze kuyruğu hatası: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.scrape.close(), this.analyze.close(), this.match.close(), this.notify.close(), this.notifyTelegram.close()]);
  }
}
