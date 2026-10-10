import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@oto/db';
import { generateToken, hashToken } from '@oto/server-common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import { MailService } from '../mail/mail.service';
import { verifyEmailMail } from '../mail/templates';
import { buildLink } from './links';
import { VERIFY_TTL_MS } from './auth.constants';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** E-posta gönderilemezse kayıt başarısız olmaz; hata loglanır. */
  async sendFor(user: User): Promise<string | null> {
    const token = generateToken();
    let tokenId: string;
    try {
      const row = await this.prisma.emailVerificationToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
        select: { id: true },
      });
      tokenId = row.id;
    } catch (err) {
      this.logger.warn(`Verification token create failed for user ${user.id}: ${String(err)}`);
      return null;
    }
    const link = buildLink(this.env.PUBLIC_BASE_URL, '/verify-email', token);
    void this.mail
      .send({ to: user.email, ...verifyEmailMail(user.name, link) })
      .catch((err: unknown) => this.logger.warn(`Verification mail failed for user ${user.id}: ${String(err)}`));
    return tokenId;
  }

  /** Kullanıcının var olup olmadığını sızdırmaz; e-posta başına 60 sn'de bir gönderir. */
  async resend(email: string): Promise<void> {
    const key = `auth:resend:${email.toLowerCase()}`;
    if ((await this.redis.set(key, '1', 'EX', 60, 'NX')) !== 'OK') return;
    // Yanıt süresi kullanıcının varlığına bağlı olmasın: işi arka planda yap.
    void this.resendNow(email).catch((err: unknown) => this.logger.warn(`Resend verification failed: ${String(err)}`));
  }

  private async resendNow(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || user.emailVerifiedAt) return;
    const newId = await this.sendFor(user);
    if (!newId) return;
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, usedAt: null, id: { not: newId } },
      data: { usedAt: new Date() },
    });
  }

  async verify(token: string): Promise<boolean> {
    const row = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return false;
    const now = new Date();
    const used = await this.prisma.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) return false;
    await this.prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: now } });
    return true;
  }
}
