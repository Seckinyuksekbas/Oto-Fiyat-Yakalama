import { Injectable } from '@nestjs/common';
import type { Notification, Prisma } from '@oto/db';
import type { ListNotificationsQuery, MarkNotificationsReadInput } from '@oto/shared';
import { PrismaService } from '../../infra/prisma.service';

@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, q: ListNotificationsQuery): Promise<Notification[]> {
    const and: Prisma.NotificationWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.channel) and.push({ channel: q.channel });
    if (q.unread === true) and.push({ channel: 'IN_APP', readAt: null });
    if (q.unread === false) and.push({ readAt: { not: null } });
    if (q.cursor) and.push({ id: { lt: q.cursor } });
    return this.prisma.notification.findMany({
      where: { userId, AND: and },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, channel: 'IN_APP', readAt: null } });
  }

  /** SSE "ready": okunmamış sayı ve aynı anda görülen en büyük IN_APP bildirim id'si (yoksa null). */
  async readySnapshot(userId: string): Promise<{ unreadCount: number; lastId: number | null }> {
    const [unreadCount, last] = await this.prisma.$transaction([
      this.prisma.notification.count({ where: { userId, channel: 'IN_APP', readAt: null } }),
      this.prisma.notification.aggregate({ where: { userId, channel: 'IN_APP' }, _max: { id: true } }),
    ]);
    return { unreadCount, lastId: last._max.id ?? null };
  }

  async markRead(userId: string, input: MarkNotificationsReadInput): Promise<number> {
    const res = await this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null, ...('ids' in input ? { id: { in: input.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return res.count;
  }
}
