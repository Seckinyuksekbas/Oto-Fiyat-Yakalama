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

  async markRead(userId: string, input: MarkNotificationsReadInput): Promise<number> {
    const res = await this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null, ...('ids' in input ? { id: { in: input.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return res.count;
  }
}
