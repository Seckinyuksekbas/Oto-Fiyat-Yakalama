import type { Prisma } from '@prisma/client';

/**
 * Günlük bildirim kotasına SAYILAN satırlar. `lastError <> 'USER_INACTIVE'` SQL'de NULL için UNKNOWN verir
 * (satırı eler), bu yüzden NULL açıkça ele alınır. API (me/admin) ve worker planner aynı tanımı kullanır.
 */
export const COUNTS_TOWARD_QUOTA: Prisma.NotificationWhereInput = {
  OR: [{ status: { not: 'FAILED' } }, { lastError: null }, { lastError: { not: 'USER_INACTIVE' } }],
};

/**
 * Tx içinde ACTIVE SUPER_ADMIN kümesini id sırasıyla `FOR UPDATE` kilitler ve id'lerini döner.
 * Rol düşürme / askıya alma / silme yolları AYNI sırayla kilitler (deadlock yok); kilit sonrası okuma günceldir.
 */
export async function lockActiveSuperAdmins(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/** Süper admin kümesini, sonra hedef satırı kilitler; hedefi ve kilit altındaki ACTIVE süper admin sayısını döner. */
export async function lockUserForUpdate(tx: Prisma.TransactionClient, userId: string) {
  const supers = await lockActiveSuperAdmins(tx);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const target = await tx.user.findUnique({ where: { id: userId } });
  return { target, activeSupers: supers.length };
}

/** true: hedef son ACTIVE süper admin ise kaldırılamaz/düşürülemez. */
export function isLastActiveSuperAdmin(target: { role: string; status: string }, activeSupers: number): boolean {
  return target.role === 'SUPER_ADMIN' && target.status === 'ACTIVE' && activeSupers <= 1;
}

/**
 * KVKK: kişisel alanlar anonimleştirilir; profiller, kanallar, favoriler, oturumlar ve token'lar silinir;
 * bekleyen bildirimler FAILED/USER_INACTIVE olur; kullanıcıyı hedefleyen eski denetim kayıtlarının before/after
 * içeriği redakte edilir. Bildirimler saklama süresi sonunda temizlenir. Çağıranın transaction'ında çalışır.
 */
export async function anonymizeUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.searchProfile.deleteMany({ where: { userId } });
  await tx.notificationChannel.deleteMany({ where: { userId } });
  await tx.favorite.deleteMany({ where: { userId } });
  await tx.session.deleteMany({ where: { userId } });
  await tx.emailVerificationToken.deleteMany({ where: { userId } });
  await tx.passwordResetToken.deleteMany({ where: { userId } });
  await tx.telegramLinkToken.deleteMany({ where: { userId } });
  await tx.notification.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'FAILED', lastError: 'USER_INACTIVE' } });
  await tx.auditLog.updateMany({
    where: { targetType: 'User', targetId: userId },
    data: { before: { redacted: true }, after: { redacted: true } },
  });
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
