import { Injectable } from '@nestjs/common';
import { anonymizeUser, COUNTS_TOWARD_QUOTA, isLastActiveSuperAdmin, lockUserForUpdate, resolveUserPlan, type User } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

/** /me altındaki TEK veri erişim noktası. Her sorgu userId ile kapsamlanır. */
@Injectable()
export class MeRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUser(userId: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } } });
  }

  /** API ve worker için ortak limit çözümleme (packages/db). */
  resolvePlan(userId: string, now: Date) {
    return resolveUserPlan(this.prisma, userId, now);
  }

  countSearchProfiles(userId: string) {
    return this.prisma.searchProfile.count({ where: { userId } });
  }

  countExternalNotificationsSince(userId: string, since: Date) {
    return this.prisma.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, AND: [COUNTS_TOWARD_QUOTA], createdAt: { gte: since } },
    });
  }

  /** DELETED hesaplara yazmaz; kayıt yoksa/silinmişse null. */
  async updateName(userId: string, name: string): Promise<User | null> {
    const res = await this.prisma.user.updateMany({ where: { id: userId, status: { not: 'DELETED' } }, data: { name } });
    if (res.count !== 1) return null;
    return this.findUser(userId);
  }

  /** Kullanıcının kullanılmamış tüm şifre sıfırlama token'larını geçersiz kılar. */
  async invalidateResetTokens(userId: string): Promise<void> {
    await this.prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  /**
   * KVKK anonimleştirme (packages/db; admin silme ile aynı kurallar). Son ACTIVE SUPER_ADMIN kontrolü aynı tx'te,
   * süper admin kümesi kilidi altında yapılır. Dönüş: 'LAST_SUPER_ADMIN' ise hiçbir şey değişmez.
   */
  async anonymizeAndDelete(userId: string): Promise<'DELETED' | 'LAST_SUPER_ADMIN' | 'NOT_FOUND'> {
    return this.prisma.$transaction(async (tx) => {
      const { target, activeSupers } = await lockUserForUpdate(tx, userId);
      if (!target || target.status === 'DELETED') return 'NOT_FOUND';
      if (isLastActiveSuperAdmin(target, activeSupers)) return 'LAST_SUPER_ADMIN';
      await anonymizeUser(tx, userId);
      return 'DELETED';
    });
  }
}
