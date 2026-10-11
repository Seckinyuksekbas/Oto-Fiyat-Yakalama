import type { Prisma } from '@prisma/client';

/**
 * KVKK: kişisel alanlar anonimleştirilir; profiller, kanallar, favoriler, oturumlar ve token'lar silinir.
 * Bildirimler saklama süresi sonunda temizlenir. Çağıranın transaction'ı içinde çalıştırılmalıdır
 * (kullanıcı kendi hesabını sildiğinde ve yönetici sildiğinde AYNI kurallar uygulanır).
 */
export async function anonymizeUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.searchProfile.deleteMany({ where: { userId } });
  await tx.notificationChannel.deleteMany({ where: { userId } });
  await tx.favorite.deleteMany({ where: { userId } });
  await tx.session.deleteMany({ where: { userId } });
  await tx.emailVerificationToken.deleteMany({ where: { userId } });
  await tx.passwordResetToken.deleteMany({ where: { userId } });
  await tx.telegramLinkToken.deleteMany({ where: { userId } });
  await tx.user.update({
    where: { id: userId },
    data: {
      status: 'DELETED',
      email: `deleted+${userId}@invalid.local`,
      name: 'Silinmiş kullanıcı',
      passwordHash: '',
      emailVerifiedAt: null,
    },
  });
}
