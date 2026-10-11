import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { AnalysisSweepService } from './analysis-sweep.service';
import { MonitorService } from './monitor.service';
import { NotificationSweepService } from './notification-sweep.service';
import { RetentionService } from './retention.service';
import { SubscriptionSweepService } from './subscription-sweep.service';
import { SchedulerService } from './scheduler.service';

const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;

/** Yalnızca ROLE=scheduler süreçlerinde yüklenir; tek instance çalışmalıdır. */
@Injectable()
export class SchedulerLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerLoop.name);
  private tickTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private ticking = false;
  private lastMonitorAt = 0;

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly sweep: AnalysisSweepService,
    private readonly notifySweep: NotificationSweepService,
    private readonly subscriptionSweep: SubscriptionSweepService,
    private readonly monitor: MonitorService,
    private readonly retention: RetentionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    void this.safeTick();
    void this.safeCleanup();
    this.tickTimer = setInterval(() => void this.safeTick(), this.env.SCHEDULER_TICK_MS);
    this.cleanupTimer = setInterval(() => void this.safeCleanup(), CLEANUP_EVERY_MS);
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step('Scheduler tick', async () => {
        const n = await this.scheduler.tick();
        if (n > 0) this.logger.log(`${n} tarama işi kuyruğa eklendi`);
      });
      await this.step('Gece yeniden analizi', () => this.sweep.maybeRunNightly());
      await this.step('Eşleştirme yeniden gönderimi', async () => {
        const requeued = await this.sweep.requeuePendingMatches();
        if (requeued > 0) this.logger.warn(`${requeued} eşleştirme olayı yeniden kuyruğa alındı`);
      });
      await this.step('Bildirim yeniden gönderimi', () => this.notifySweep.requeuePending());
      await this.step('Abonelik süresi süpürmesi', () => this.subscriptionSweep.run());
      if (Date.now() - this.lastMonitorAt >= this.env.MONITOR_INTERVAL_MS) {
        this.lastMonitorAt = Date.now();
        await this.step('Alarm izleme', () => this.monitor.check(new Date()));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${name} başarısız: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async safeCleanup(): Promise<void> {
    try {
      await this.retention.run(); // sonuç (tablo → sayı) RetentionService içinde info log'una yazılır
    } catch (err) {
      this.logger.error(`Temizlik başarısız: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
