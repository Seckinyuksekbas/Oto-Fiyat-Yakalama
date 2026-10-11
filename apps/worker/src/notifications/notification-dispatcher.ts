import { Injectable } from '@nestjs/common';
import { notifyJobId, type NotifyJobData } from '@oto/shared';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service';
import { NOTIFY_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** jobId = notify-<id>: aynı bildirim iki kez kuyrukta beklemez. Kuyruğa eklenenlerin queuedAt değeri yazılır. */
  async enqueue(items: Array<{ id: number; channel: string }>): Promise<number> {
    const groups: Array<[Queue<NotifyJobData>, number[]]> = [
      [this.queues.notify, items.filter((i) => i.channel === 'IN_APP').map((i) => i.id)],
      [this.queues.notifyTelegram, items.filter((i) => i.channel === 'TELEGRAM').map((i) => i.id)],
    ];
    let n = 0;
    for (const [queue, ids] of groups) {
      if (ids.length === 0) continue;
      await queue.addBulk(ids.map((id) => ({ name: 'notify', data: { notificationId: id }, opts: { jobId: notifyJobId(id), ...NOTIFY_JOB_OPTS } })));
      await this.prisma.notification.updateMany({ where: { id: { in: ids } }, data: { queuedAt: new Date() } });
      n += ids.length;
    }
    return n;
  }
}
