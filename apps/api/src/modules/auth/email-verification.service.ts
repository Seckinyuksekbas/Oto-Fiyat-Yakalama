import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@oto/db';
import { generateToken, hashToken } from '../../common/crypto/tokens';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { MailService } from '../mail/mail.service';
import { verifyEmailMail } from '../mail/templates';
import { VERIFY_TTL_MS } from './auth.constants';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** E-posta gönderilemezse kayıt başarısız olmaz; hata loglanır. */
  async sendFor(user: User): Promise<void> {
    const token = generateToken();
    await this.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
    });
    const link = `${this.env.PUBLIC_BASE_URL}/verify-email?token=${token}`;
    try {
      await this.mail.send({ to: user.email, ...verifyEmailMail(user.name, link) });
    } catch (err) {
      this.logger.warn({ err, userId: user.id }, 'Verification mail failed');
    }
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
