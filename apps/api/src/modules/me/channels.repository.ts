import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service';

export interface TelegramChannelRow {
  isVerified: boolean;
  isEnabled: boolean;
}

@Injectable()
export class ChannelsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Yalnızca durum alanları; config / externalIdHash asla seçilmez. */
  findTelegram(userId: string): Promise<TelegramChannelRow | null> {
    return this.prisma.notificationChannel.findUnique({
      where: { userId_type: { userId, type: 'TELEGRAM' } },
      select: { isVerified: true, isEnabled: true },
    });
  }

  async setTelegramEnabled(userId: string, isEnabled: boolean): Promise<number> {
    const res = await this.prisma.notificationChannel.updateMany({ where: { userId, type: 'TELEGRAM' }, data: { isEnabled } });
    return res.count;
  }

  async deleteTelegram(userId: string): Promise<number> {
    const res = await this.prisma.notificationChannel.deleteMany({ where: { userId, type: 'TELEGRAM' } });
    return res.count;
  }

  /** Önceki kullanılmamış kodları geçersiz kılar, yenisini oluşturur. */
  async createLinkCode(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.telegramLinkToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.telegramLinkToken.create({ data: { userId, codeHash, expiresAt } }),
    ]);
  }
}
