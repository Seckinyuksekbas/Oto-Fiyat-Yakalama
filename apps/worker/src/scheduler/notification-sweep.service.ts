import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';

export const NOTIFY_REQUEUE_AFTER_MS = 60_000;

@Injectable()
export class NotificationSweepService {
  private readonly logger = new Logger(NotificationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  /** Commit sonrası kuyruğa eklenemeyen PENDING bildirimleri yeniden ekler (en eskiler önce, 500'lük sayfa). */
  async requeuePending(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'PENDING', queuedAt: null, channel: { in: ['IN_APP', 'TELEGRAM'] }, createdAt: { lt: new Date(now.getTime() - NOTIFY_REQUEUE_AFTER_MS) } },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, channel: true },
    });
    if (rows.length === 0) return 0;
    const n = await this.dispatcher.enqueue(rows);
    this.logger.warn(`${n} bildirim yeniden kuyruğa alındı`);
    return n;
  }
}
