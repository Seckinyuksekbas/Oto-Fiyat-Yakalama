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

  updateName(userId: string, name: string): Promise<User> {
    return this.prisma.user.update({ where: { id: userId }, data: { name } });
  }

  async findPasswordHash(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } }, select: { passwordHash: true } });
    return u?.passwordHash ?? null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  /** KVKK: kişisel alanlar anonimleştirilir; profiller, kanallar, favoriler silinir. Bildirimler saklama süresi sonunda temizlenir. */
  async anonymizeAndDelete(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.searchProfile.deleteMany({ where: { userId } }),
      this.prisma.notificationChannel.deleteMany({ where: { userId } }),
      this.prisma.favorite.deleteMany({ where: { userId } }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          email: `deleted+${userId}@invalid.local`,
          name: 'Silinmiş kullanıcı',
          passwordHash: '',
          emailVerifiedAt: null,
        },
      }),
    ]);
  }
}
