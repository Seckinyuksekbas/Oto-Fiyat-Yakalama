import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ResetPasswordInput } from '@oto/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { ClientMeta } from '../../common/client-meta';
import { generateToken, hashToken } from '@oto/server-common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import { MailService } from '../mail/mail.service';
import { resetPasswordMail } from '../mail/templates';
import { buildLink } from './links';
import { FORGOT_COOLDOWN_SEC, RESET_TTL_MS } from './auth.constants';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Kullanıcının var olup olmadığını dışarı sızdırmaz; e-posta başına 60 sn'de bir gönderir.
   * Bekleme anahtarı e-postanın sha256'sıdır (Redis'te e-posta düz yazılmaz); bekleme sırasında da yanıt 204'tür.
   */
  async request(email: string): Promise<void> {
    const key = `auth:forgot:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
    if ((await this.redis.set(key, '1', 'EX', FORGOT_COOLDOWN_SEC, 'NX')) !== 'OK') return;
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return;
    const token = generateToken();
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    const link = buildLink(this.env.PUBLIC_BASE_URL, '/reset-password', token);
    // Beklenmez: yanıt süresi kullanıcının var olup olmadığını sızdırmasın.
    void this.mail
      .send({ to: user.email, ...resetPasswordMail(user.name, link) })
      .catch((err: unknown) => this.logger.warn(`Reset mail failed for user ${user.id}: ${String(err)}`));
  }

  async reset(input: ResetPasswordInput, meta: ClientMeta): Promise<boolean> {
    const row = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(input.token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return false;
    await this.passwords.assertNotBreached(input.newPassword);
    const used = await this.prisma.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) return false;
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = new Date();
    await this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await this.prisma.user.updateMany({ where: { id: row.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    await this.prisma.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } });
    await this.sessions.revokeAllForUser(row.userId);
    await this.audit.record({
      actorId: row.userId,
      action: 'auth.password_reset',
      targetType: 'User',
      targetId: row.userId,
      ip: meta.ip,
    });
    return true;
  }
}
