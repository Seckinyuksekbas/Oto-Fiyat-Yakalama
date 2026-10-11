import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, type AdminQueueClean, type AdminQueueName } from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError } from '../../common/errors/app-error';
import { ADMIN_QUEUE_NAMES, AdminQueues } from '../../infra/admin-queues.service';
import { PrismaService } from '../../infra/prisma.service';

const COUNT_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized', 'paused'] as const;
/** Tek istekte yeniden denenecek / temizlenecek en fazla iş (Redis'i uzun süre meşgul etmez; gerekirse tekrar tıklanır). */
export const QUEUE_RETRY_LIMIT = 1000;
export const QUEUE_CLEAN_LIMIT = 1000;

const unavailable = () => new AppError(ErrorCode.INTERNAL, 503, 'Kuyruk sunucusuna şu anda erişilemiyor');

@Injectable()
export class AdminQueuesService {
  private readonly logger = new Logger(AdminQueuesService.name);

  constructor(
    private readonly queues: AdminQueues,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
   * Yalnızca `failed` durumundaki işler (en fazla 1000) yeniden denenir. Eşzamanlı ikinci tıklamada aynı iş artık
   * failed olmadığından BullMQ `retry` reddeder ve sayılmaz (çift yeniden deneme yok). Hiçbir iş yeniden denenmediyse
   * denetim kaydı yazılmaz. Kuyruk işlemi Redis'te olduğundan denetimle aynı transaction'a giremez: işlemden sonra yazılır.
   */
  async retryFailed(ctx: AuditCtx, name: AdminQueueName): Promise<{ retried: number }> {
    const q = this.queues.get(name);
    let jobs;
    try {
      jobs = await q.getJobs(['failed'], 0, QUEUE_RETRY_LIMIT - 1, true);
    } catch {
      throw unavailable();
    }
    let retried = 0;
    for (const job of jobs) {
      try {
        await job.retry('failed');
        retried += 1;
      } catch (err) {
        // Arada başka bir istek yeniden denedi ya da iş silindi: sayılmaz.
        this.logger.debug(`İş yeniden denenmedi (${name}/${job.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (retried > 0) {
      await this.prisma.$transaction((tx) => this.audit.recordInTx(tx, ctx, { targetType: 'Queue', targetId: name, after: { retried } }));
    }
    return { retried };
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
      await this.prisma.$transaction((tx) =>
        this.audit.recordInTx(tx, ctx, { targetType: 'Queue', targetId: name, after: { state: body.state, olderThanSec: body.olderThanSec, removed } }),
      );
    }
    return { removed };
  }
}
