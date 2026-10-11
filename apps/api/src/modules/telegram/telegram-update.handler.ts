import { Inject, Injectable, Logger } from '@nestjs/common';
import { Encryptor, hashToken } from '@oto/server-common';
import type { TelegramClient, TelegramUpdate } from '@oto/telegram';
import { UserEventsService } from '../../infra/user-events.service';
import { PrismaService } from '../../infra/prisma.service';
import { TELEGRAM_API } from './telegram.config';

@Injectable()
export class TelegramUpdateHandler {
  private readonly logger = new Logger(TelegramUpdateHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptor: Encryptor,
    private readonly events: UserEventsService,
    @Inject(TELEGRAM_API) private readonly bot: TelegramClient | null,
  ) {}

  async handle(u: TelegramUpdate): Promise<void> {
    if (!this.bot) return;
    if (u.message?.text?.startsWith('/start')) return this.onStart(u.message.chat.id, u.message.text.slice('/start'.length).trim());
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.my_chat_member && ['kicked', 'left'].includes(u.my_chat_member.new_chat_member.status)) {
      await this.prisma.notificationChannel.updateMany({
        where: { type: 'TELEGRAM', externalIdHash: hashToken(String(u.my_chat_member.chat.id)) },
        data: { isEnabled: false },
      });
    }
  }

  private async onStart(chatId: number, code: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
      await this.reply(chatId, 'Merhaba! Hesabınızı bağlamak için panelde Ayarlar → "Telegram\'ı bağla" adımını kullanın.');
      return;
    }
    const now = new Date();
    const linked = await this.prisma.$transaction(async (tx) => {
      const token = await tx.telegramLinkToken.findUnique({ where: { codeHash: hashToken(code) }, include: { user: true } });
      if (!token || token.usedAt || token.expiresAt <= now) return null;
      if (token.user.status !== 'ACTIVE' || !token.user.emailVerifiedAt) return null;
      const used = await tx.telegramLinkToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) return null;
      const data = { config: this.encryptor.encryptJson({ chatId }), externalIdHash: hashToken(String(chatId)), isVerified: true, isEnabled: true };
      await tx.notificationChannel.upsert({
        where: { userId_type: { userId: token.userId, type: 'TELEGRAM' } },
        update: data,
        create: { userId: token.userId, type: 'TELEGRAM', ...data },
      });
      return tx.notification.create({
        data: { userId: token.userId, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', sentAt: now, payload: { type: 'TELEGRAM_LINKED' } },
      });
    });
    if (!linked) {
      await this.reply(chatId, 'Bağlantı kodu geçersiz veya süresi dolmuş. Panelden yeni bir kod oluşturun.');
      return;
    }
    await this.events
      .publish(linked.userId, {
        type: 'notification',
        notification: { id: linked.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: linked.payload, createdAt: linked.createdAt.toISOString() },
      })
      .catch((err: unknown) => this.logger.warn(`Bağlama olayı yayınlanamadı: ${String(err)}`));
    await this.reply(chatId, '✅ Hesabınız bağlandı. Eşleşen fırsatlar artık buraya gelecek.');
  }

  private async onCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const m = /^fav:(\d{1,10})$/.exec(cb.data ?? '');
    const chatId = cb.message?.chat.id;
    if (!m || chatId === undefined) return void (await this.answer(cb.id, 'Geçersiz işlem'));
    const listingId = Number(m[1]);
    const channels = await this.prisma.notificationChannel.findMany({
      where: { type: 'TELEGRAM', isVerified: true, externalIdHash: hashToken(String(chatId)), user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    if (channels.length === 0) return void (await this.answer(cb.id, 'Hesap bağlı değil'));
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, select: { id: true } });
    if (!listing) return void (await this.answer(cb.id, 'İlan bulunamadı'));
    for (const c of channels) {
      await this.prisma.favorite.upsert({ where: { userId_listingId: { userId: c.userId, listingId } }, update: {}, create: { userId: c.userId, listingId } });
    }
    await this.answer(cb.id, 'Favorilere eklendi ⭐');
  }

  private async reply(chatId: number, text: string) {
    await this.bot?.sendMessage(chatId, text).catch((err: unknown) => this.logger.warn(`Bot yanıtı gönderilemedi: ${String(err)}`));
  }

  private async answer(id: string, text: string) {
    await this.bot?.answerCallbackQuery(id, text).catch((err: unknown) => this.logger.warn(`Callback yanıtlanamadı: ${String(err)}`));
  }
}
