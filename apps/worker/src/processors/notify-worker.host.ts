import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { redactSecrets } from '@oto/server-common';
import { notifyJobSchema, QueueName, type NotifyJobData } from '@oto/shared';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { closeWithTimeout } from '../common/close-with-timeout';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';
import { notifyBackoffMs, RetryableNotifyError } from '../notifications/backoff';
import { PrismaService } from '../infra/prisma.service';
import { NotifyService } from '../notifications/notify.service';

export const NOTIFY_WORKER_AUTOSTART = Symbol('NOTIFY_WORKER_AUTOSTART');

@Injectable()
export class NotifyWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotifyWorkerHost.name);
  private workers: Worker<NotifyJobData>[] = [];

  constructor(
    private readonly notify: NotifyService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(NOTIFY_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.workers.length) return;
    const processor = async (job: Job<NotifyJobData>, token?: string) => {
      const parsed = notifyJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError(`Geçersiz bildirim işi: ${parsed.error.message}`);
      const attempt = { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 };
      let r;
      try {
        r = await this.notify.process(parsed.data.notificationId, attempt);
      } catch (err) {
        await this.notify.recordUnexpectedFailure(parsed.data.notificationId, err, attempt).catch((e: unknown) => this.logger.error(`Hata kaydedilemedi: ${String(e)}`));
        throw err;
      }
      if (r.kind === 'THROTTLED') {
        await job.moveToDelayed(Date.now() + r.retryAfterMs, token);
        throw new DelayedError();
      }
      if (r.kind === 'RETRY') throw new RetryableNotifyError(r.error, r.retryAfterMs);
    };
    const common = {
      connection: bullConnection(this.env.REDIS_URL),
      settings: { backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => notifyBackoffMs(attemptsMade, err) },
    };
    this.workers = [
      new Worker<NotifyJobData>(QueueName.NOTIFY, processor, { ...common, concurrency: this.env.NOTIFY_CONCURRENCY }),
      new Worker<NotifyJobData>(QueueName.NOTIFY_TELEGRAM, processor, { ...common, concurrency: 5, limiter: { max: 25, duration: 1000 } }),
    ];
    for (const w of this.workers) {
      w.on('error', (err) => this.logger.error(`Bildirim worker hatası: ${err.message}`));
      w.on('failed', (job, err) => {
        this.logger.warn(`Bildirim işi ${job?.id} başarısız (deneme ${job?.attemptsMade}): ${err.message}`);
        void this.failIfExhausted(job, err).catch((e: unknown) => this.logger.error(`Tükenen iş kaydedilemedi: ${String(e)}`));
      });
    }
  }

  /** İş tükendi (veya stalled sınırını aştı) ama satır hâlâ PENDING ise yetim kalmasın: FAILED yapılır (token yok). */
  async failIfExhausted(job: Job<NotifyJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted && !/stalled/i.test(err.message)) return;
    const id = (job.data as Partial<NotifyJobData> | undefined)?.notificationId;
    if (typeof id !== 'number') return;
    await this.prisma.notification.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'FAILED', lastError: redactSecrets(err.message).slice(0, 500) },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => closeWithTimeout(w, this.env.SHUTDOWN_TIMEOUT_MS, this.logger)));
    this.workers = [];
  }
}
