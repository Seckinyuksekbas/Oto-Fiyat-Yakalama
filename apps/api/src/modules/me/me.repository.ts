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

  findPlanByCode(code: string): Promise<SubscriptionPlan | null> {
    return this.prisma.subscriptionPlan.findUnique({ where: { code } });
  }

  countSearchProfiles(userId: string) {
    return this.prisma.searchProfile.count({ where: { userId } });
  }

  countExternalNotificationsSince(userId: string, since: Date) {
    return this.prisma.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, createdAt: { gte: since } },
    });
  }

  /** DELETED hesaplara yazmaz; kayıt yoksa/silinmişse null. */
  async updateName(userId: string, name: string): Promise<User | null> {
    const res = await this.prisma.user.updateMany({ where: { id: userId, status: { not: 'DELETED' } }, data: { name } });
    if (res.count !== 1) return null;
    return this.findUser(userId);
  }

  async hasOtherActiveSuperAdmin(userId: string): Promise<boolean> {
    const n = await this.prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE', id: { not: userId } } });
    return n > 0;
  }

  async findRole(userId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } }, select: { role: true } });
    return u?.role ?? null;
  }

  /** Kullanıcının kullanılmamış tüm şifre sıfırlama token'larını geçersiz kılar. */
  async invalidateResetTokens(userId: string): Promise<void> {
    await this.prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
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
      this.prisma.session.deleteMany({ where: { userId } }),
      this.prisma.emailVerificationToken.deleteMany({ where: { userId } }),
      this.prisma.passwordResetToken.deleteMany({ where: { userId } }),
      this.prisma.telegramLinkToken.deleteMany({ where: { userId } }),
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
