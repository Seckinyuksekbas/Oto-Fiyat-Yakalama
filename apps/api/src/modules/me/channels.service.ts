import { Inject, Injectable } from '@nestjs/common';
import { generateToken, hashToken } from '@oto/server-common';
import { ErrorCode } from '@oto/shared';
import type { TelegramClient } from '@oto/telegram';
import { AppError, Errors } from '../../common/errors/app-error';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { TELEGRAM_API } from '../telegram/telegram.config';
import { ChannelsRepository } from './channels.repository';
import { LimitsService } from './limits.service';

const LINK_TTL_MS = 10 * 60_000;

@Injectable()
export class ChannelsService {
  constructor(
    private readonly repo: ChannelsRepository,
    private readonly limits: LimitsService,
    @Inject(TELEGRAM_API) private readonly bot: TelegramClient | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(userId: string) {
    const tg = await this.repo.findTelegram(userId);
    return {
      items: [
        { type: 'IN_APP', isVerified: true, isEnabled: true },
        { type: 'TELEGRAM', linked: !!tg?.isVerified, isVerified: tg?.isVerified ?? false, isEnabled: tg?.isEnabled ?? false },
      ],
      telegramAvailable: !!this.bot,
    };
  }

  async createLink(userId: string) {
    if (!this.bot || !this.env.TELEGRAM_BOT_USERNAME) throw new AppError(ErrorCode.FEATURE_DISABLED, 503, 'Telegram bildirimleri şu anda kullanılamıyor');
    const lim = await this.limits.forUser(userId);
    if (!lim.emailVerified) throw new AppError(ErrorCode.EMAIL_NOT_VERIFIED, 403, "Telegram'ı bağlamak için önce e-postanızı doğrulayın");
    if (!lim.limits.channels.includes('TELEGRAM')) throw new AppError(ErrorCode.LIMIT_REACHED, 403, 'Planınız Telegram bildirimlerini içermiyor', { channel: 'TELEGRAM' });
    const code = generateToken(16);
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await this.repo.createLinkCode(userId, hashToken(code), expiresAt);
    return { deepLink: `https://t.me/${this.env.TELEGRAM_BOT_USERNAME}?start=${code}`, expiresAt };
  }

  async patch(userId: string, type: 'IN_APP' | 'TELEGRAM', isEnabled: boolean) {
    if (type === 'IN_APP') throw new AppError(ErrorCode.INVALID_OPERATION, 400, 'Uygulama içi bildirimler kapatılamaz');
    const tg = await this.repo.findTelegram(userId);
    if (!tg?.isVerified) throw Errors.notFound();
    if (isEnabled) {
      const lim = await this.limits.forUser(userId);
      if (!lim.limits.channels.includes('TELEGRAM')) throw new AppError(ErrorCode.LIMIT_REACHED, 403, 'Planınız Telegram bildirimlerini içermiyor', { channel: 'TELEGRAM' });
    }
    await this.repo.setTelegramEnabled(userId, isEnabled);
    return { type: 'TELEGRAM', linked: true, isVerified: true, isEnabled };
  }

  async unlink(userId: string): Promise<void> {
    if ((await this.repo.deleteTelegram(userId)) === 0) throw Errors.notFound();
  }
}
