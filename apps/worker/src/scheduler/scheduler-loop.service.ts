import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { AnalysisSweepService } from './analysis-sweep.service';
import { LeaderLockService } from './leader-lock.service';
import { MonitorService } from './monitor.service';
import { NotificationSweepService } from './notification-sweep.service';
import { RetentionService } from './retention.service';
import { SubscriptionSweepService } from './subscription-sweep.service';
import { SchedulerService } from './scheduler.service';

const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Yalnızca ROLE=scheduler süreçlerinde yüklenir. Birden çok instance çalışabilir: tick, alarm izleme ve günlük temizlik
 * yalnız `scheduler:leader` kilidini tutan süreçte yapılır (LeaderLockService); diğerleri beklemede kalır.
 */
@Injectable()
export class SchedulerLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerLoop.name);
  private tickTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private ticking = false;
  /** Önceki temizlik bitmeden yenisi başlamaz (büyük birikimde bir koşu 24 saati aşabilir). */
  private cleaning = false;
  private lastMonitorAt = 0;

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly sweep: AnalysisSweepService,
    private readonly notifySweep: NotificationSweepService,
    private readonly subscriptionSweep: SubscriptionSweepService,
    private readonly monitor: MonitorService,
    private readonly retention: RetentionService,
    private readonly leader: LeaderLockService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Liderliği alan süreç (açılışta ya da yük devrinde) temizliği hemen çalıştırır; sonra 24 saatte bir.
    this.leader.onAcquired(() => void this.safeCleanup());
    await this.leader.start();
    void this.safeTick();
    this.tickTimer = setInterval(() => void this.safeTick(), this.env.SCHEDULER_TICK_MS);
    this.cleanupTimer = setInterval(() => void this.safeCleanup(), CLEANUP_EVERY_MS);
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Lider değilse hiçbir şey yapmaz; liderlik tick ortasında kaybedilirse kalan adımlar atlanır.
   * O anda yürüyen adım (ör. `scheduler.tick`) ve süren bir temizlik koşusu yarıda kesilmez, bitmesine izin verilir:
   * hepsi idempotent ve satır/advisory kilitleriyle korunur, yeni lider ile kısa bir örtüşme çift iş üretmez.
   */
  async safeTick(): Promise<void> {
    if (this.ticking || !this.leader.isLeader()) return;
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
      if (this.leader.isLeader() && Date.now() - this.lastMonitorAt >= this.env.MONITOR_INTERVAL_MS) {
        this.lastMonitorAt = Date.now();
        await this.step('Alarm izleme', () => this.monitor.check(new Date()));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.leader.isLeader()) return;
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${name} başarısız: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async safeCleanup(): Promise<void> {
    if (this.cleaning || !this.leader.isLeader()) return;
    this.cleaning = true;
    try {
      await this.retention.run(); // sonuç (tablo → sayı) RetentionService içinde info log'una yazılır
    } catch (err) {
      this.logger.error(`Temizlik başarısız: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.cleaning = false;
    }
  }
}
