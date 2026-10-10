import { Injectable } from '@nestjs/common';
import type { SubscriptionPlan, User, UserSubscription } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

/** /me altındaki TEK veri erişim noktası. Her sorgu userId ile kapsamlanır. */
@Injectable()
export class MeRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUser(userId: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } } });
  }

  findActiveSubscription(userId: string): Promise<(UserSubscription & { plan: SubscriptionPlan }) | null> {
    return this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { plan: true },
      orderBy: { startsAt: 'desc' },
    });
  }

  countSearchProfiles(userId: string) {
    return this.prisma.searchProfile.count({ where: { userId } });
  }

  countExternalNotificationsSince(userId: string, since: Date) {
    return this.prisma.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, createdAt: { gte: since } },
    });
  }
}
