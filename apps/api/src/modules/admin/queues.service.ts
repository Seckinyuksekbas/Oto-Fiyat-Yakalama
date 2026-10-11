import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, notifyJobSchema, type AdminQueueClean, type AdminQueueName } from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService, type AuditTarget } from '../../common/audit/audit.service';
import { AppError } from '../../common/errors/app-error';
import { ADMIN_QUEUE_NAMES, AdminQueues } from '../../infra/admin-queues.service';
import { PrismaService } from '../../infra/prisma.service';
import { AdminNotificationsService } from './notifications.service';

const COUNT_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized', 'paused'] as const;
/** Tek istekte yeniden denenecek / temizlenecek en fazla iş (Redis'i uzun süre meşgul etmez; gerekirse tekrar tıklanır). */
export const QUEUE_RETRY_LIMIT = 1000;
export const QUEUE_CLEAN_LIMIT = 1000;
/** Bildirim kuyruklarında başarısız işler bildirim yeniden denemesine bu boyutta parçalar halinde aktarılır. */
const NOTIFY_RETRY_CHUNK = 100;

const unavailable = () => new AppError(ErrorCode.INTERNAL, 503, 'Kuyruk sunucusuna şu anda erişilemiyor');

@Injectable()
export class AdminQueuesService {
  private readonly logger = new Logger(AdminQueuesService.name);

  constructor(
    private readonly queues: AdminQueues,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: AdminNotificationsService,
  ) {}

  async list() {
    try {
      return await Promise.all(
        ADMIN_QUEUE_NAMES.map(async (name) => {
          const q = this.queues.get(name);
          const [counts, isPaused] = await Promise.all([q.getJobCounts(...COUNT_STATES), q.isPaused()]);
          return { name, isPaused, counts };
        }),
      );
    } catch {
      throw unavailable();
    }
  }

  /**
   * Yalnızca `failed` durumundaki işler (en fazla 1000) yeniden denenir; deneme sayaçları sıfırlanır (tükenmiş iş tam
   * deneme hakkıyla döner). Eşzamanlı ikinci tıklamada aynı iş artık failed olmadığından BullMQ `retry` reddeder ve
   * `skipped` sayılır (çift yeniden deneme yok). Hiçbir iş yeniden denenmediyse denetim kaydı yazılmaz.
   * `notify` / `notify-telegram`: BullMQ işi yeniden canlandırmak satırı PENDING yapmaz (worker yalnızca PENDING satırı
   * işler) → işlerin notificationId'leri bildirim yeniden denemesine (koşullu DB sıfırlama + remove-then-add) aktarılır.
   */
  async retryFailed(ctx: AuditCtx, name: AdminQueueName): Promise<{ retried: number; skipped: number }> {
    const q = this.queues.get(name);
    let jobs;
    try {
      jobs = await q.getJobs(['failed'], 0, QUEUE_RETRY_LIMIT - 1, true);
    } catch {
      throw unavailable();
    }
    if (name === 'notify' || name === 'notify-telegram') return this.retryNotifyJobs(ctx, name, jobs);

    let retried = 0;
    let skipped = 0;
    for (const job of jobs) {
      try {
        await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
        retried += 1;
      } catch (err) {
        skipped += 1;
        // Arada başka bir istek yeniden denedi ya da iş silindi: sayılmaz.
        this.logger.debug(`İş yeniden denenmedi (${name}/${job.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (retried > 0) await this.auditAfterRedis(ctx, { targetType: 'Queue', targetId: name, after: { retried } });
    return { retried, skipped };
  }

  /** Bildirim işleri: notificationId'ler 100'lük parçalarla bildirim yeniden denemesine; denetim DB'de gerçekten sıfırlanan satırlar için, aynı tx'te. */
  private async retryNotifyJobs(ctx: AuditCtx, name: AdminQueueName, jobs: Array<{ data: unknown }>): Promise<{ retried: number; skipped: number }> {
    const ids: number[] = [];
    let skipped = 0;
    for (const job of jobs) {
      const parsed = notifyJobSchema.safeParse(job.data);
      if (parsed.success) ids.push(parsed.data.notificationId);
      else skipped += 1;
    }
    let retried = 0;
    for (let i = 0; i < ids.length; i += NOTIFY_RETRY_CHUNK) {
      const res = await this.notifications.retry(ctx, ids.slice(i, i + NOTIFY_RETRY_CHUNK), (changed) => ({
        targetType: 'Queue',
        targetId: name,
        after: { retried: changed.length, notificationIds: changed },
      }));
      retried += res.retried.length;
      skipped += res.skipped.length;
    }
    return { retried, skipped };
  }

  /** `olderThanSec`'ten (≥ 1 saat) eski tamamlanmış/başarısız işleri siler (istek başına en fazla 1000); boş temizlik denetlenmez. */
  async clean(ctx: AuditCtx, name: AdminQueueName, body: AdminQueueClean): Promise<{ removed: number }> {
    let ids: string[];
    try {
      ids = await this.queues.get(name).clean(body.olderThanSec * 1000, QUEUE_CLEAN_LIMIT, body.state);
    } catch {
      throw unavailable();
    }
    const removed = ids.length;
    if (removed > 0) {
      await this.auditAfterRedis(ctx, { targetType: 'Queue', targetId: name, after: { state: body.state, olderThanSec: body.olderThanSec, removed } });
    }
    return { removed };
  }

  /**
   * Kuyruk işlemi Redis'te gerçekleşti ve geri alınamaz: denetim yazımı başarısız olursa işlem yine de olmuştur.
   * Bu durumda sonuç döndürülür (istemci yeniden tıklayıp işi ikinci kez yapmasın) ve hata ERROR düzeyinde loglanır.
   */
  private async auditAfterRedis(ctx: AuditCtx, target: AuditTarget): Promise<void> {
    try {
      await this.prisma.$transaction((tx) => this.audit.recordInTx(tx, ctx, target));
    } catch (err) {
      this.logger.error(
        `Denetim kaydı yazılamadı (${ctx.action} ${target.targetType}/${target.targetId}, aktör ${ctx.actorId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
