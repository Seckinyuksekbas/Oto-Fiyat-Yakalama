import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { notifyJobId, type NotifyJobData } from '@oto/shared';
import type { Queue } from 'bullmq';
import { QueueRegistry } from '../queues/queue-registry';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';

export const NOTIFY_REQUEUE_AFTER_MS = 60_000;
/** Kuyruğa alınmış ama bu süredir PENDING kalan satırların işi gerçekten var mı diye bakılır. */
export const NOTIFY_STALE_QUEUED_MS = 30 * 60_000;

@Injectable()
export class NotificationSweepService {
  private readonly logger = new Logger(NotificationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly queues: QueueRegistry,
  ) {}

  /**
   * (1) Kuyruğa hiç alınamayanlar (queuedAt=null) yeniden eklenir.
   * (2) 30 dk'dan eski PENDING satırlar: işi kaybolmuş / başarısız-tamamlanmış kalmışsa kaldırılıp yeniden eklenir
   * (bekleyen/gecikmeli/aktif işe dokunulmaz). En eskiler önce, 500'lük sayfa.
   */
  async requeuePending(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'PENDING', queuedAt: null, channel: { in: ['IN_APP', 'TELEGRAM'] }, createdAt: { lt: new Date(now.getTime() - NOTIFY_REQUEUE_AFTER_MS) } },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, channel: true },
    });
    let n = 0;
    if (rows.length > 0) {
      n += await this.dispatcher.enqueue(rows);
      this.logger.warn(`${rows.length} bildirim yeniden kuyruğa alındı`);
    }
    n += await this.requeueStale(now);
    return n;
  }

  private async requeueStale(now: Date): Promise<number> {
    const stale = await this.prisma.notification.findMany({
      where: { status: 'PENDING', queuedAt: { lt: new Date(now.getTime() - NOTIFY_STALE_QUEUED_MS) }, channel: { in: ['IN_APP', 'TELEGRAM'] } },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, channel: true },
    });
    const todo: Array<{ id: number; channel: string }> = [];
    for (const r of stale) {
      const queue: Queue<NotifyJobData> = r.channel === 'TELEGRAM' ? this.queues.notifyTelegram : this.queues.notify;
      const job = await queue.getJob(notifyJobId(r.id));
      if (job) {
        const state = await job.getState();
        if (state === 'failed' || state === 'completed') await job.remove();
        else if (state !== 'unknown') continue; // waiting/delayed/active/prioritized/waiting-children: iş canlı
      }
      todo.push(r);
    }
    if (todo.length === 0) return 0;
    const n = await this.dispatcher.enqueue(todo); // queuedAt yenilenir
    this.logger.warn(`${n} eski PENDING bildirim yeniden kuyruğa alındı`);
    return n;
  }
}
