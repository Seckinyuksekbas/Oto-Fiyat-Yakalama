import { Inject, Injectable, Logger } from '@nestjs/common';
import { Encryptor, hashToken } from '@oto/server-common';
import type { Notification, Prisma } from '@oto/db';
import type { TelegramClient, TelegramUpdate } from '@oto/telegram';
import { RedisService } from '../../infra/redis.service';
import { UserEventsService } from '../../infra/user-events.service';
import { PrismaService } from '../../infra/prisma.service';
import { TELEGRAM_API } from './telegram.config';

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

type LinkResult = { note: Notification; email: string; previous: Notification[] };

@Injectable()
export class TelegramUpdateHandler {
  private readonly logger = new Logger(TelegramUpdateHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptor: Encryptor,
    private readonly events: UserEventsService,
    private readonly redis: RedisService,
    @Inject(TELEGRAM_API) private readonly bot: TelegramClient | null,
  ) {}

  async handle(u: TelegramUpdate): Promise<void> {
    if (!this.bot) return;
    const key = `tg:update:${u.update_id}`;
    try {
      if ((await this.redis.set(key, '1', 'EX', 3600, 'NX')) !== 'OK') return;
    } catch (err) {
      this.logger.warn(`Güncelleme tekilleştirme atlandı: ${String(err)}`);
    }
    try {
      await this.dispatch(u);
    } catch (err) {
      await this.redis.del(key).catch(() => undefined);
      throw err;
    }
  }

  private async dispatch(u: TelegramUpdate): Promise<void> {
    if (u.message?.text?.startsWith('/start')) {
      if (u.message.chat.type !== 'private') {
        await this.reply(u.message.chat.id, 'Hesabı bağlamak için botla özel sohbette (birebir mesajlaşmada) /start gönderin.');
        return;
      }
      return this.onStart(u.message.chat.id, u.message.text.slice('/start'.length).trim());
    }
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.my_chat_member && ['kicked', 'left'].includes(u.my_chat_member.new_chat_member.status)) {
      await this.onBlocked(u.my_chat_member.chat.id);
    }
  }

  private async onBlocked(chatId: number): Promise<void> {
    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.notificationChannel.findMany({
        where: { type: 'TELEGRAM', externalIdHash: hashToken(String(chatId)), isEnabled: true },
        select: { id: true, userId: true },
      });
      if (rows.length === 0) return [];
      await tx.notificationChannel.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { isEnabled: false } });
      const notes: Notification[] = [];
      for (const r of rows) notes.push(await this.securityNote(tx, r.userId, 'TELEGRAM_DISABLED', now));
      return notes;
    });
    for (const n of created) await this.publishNote(n);
  }

  private securityNote(tx: Prisma.TransactionClient, userId: string, type: string, now: Date) {
    return tx.notification.create({
      data: { userId, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', sentAt: now, payload: { type } },
    });
  }

  private async publishNote(n: Notification): Promise<void> {
    await this.events
      .publish(n.userId, {
        type: 'notification',
        notification: { id: n.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: n.payload, createdAt: n.createdAt.toISOString() },
      })
      .catch((err: unknown) => this.logger.warn(`Bildirim olayı yayınlanamadı: ${String(err)}`));
  }

  private async onStart(chatId: number, code: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
      await this.reply(chatId, 'Merhaba! Hesabınızı bağlamak için panelde Ayarlar → "Telegram\'ı bağla" adımını kullanın.');
      return;
    }
    const now = new Date();
    // Yalnızca "kod yok / kullanılmış / süresi dolmuş / hesap uygun değil" durumu null döner ve kullanıcıya
    // "geçersiz" denir. Geçici DB hataları yeniden fırlatılır; webhook 500 döner ve Telegram yeniden dener.
    const result = await this.prisma.$transaction(async (tx): Promise<LinkResult | null> => {
      const token = await tx.telegramLinkToken.findUnique({ where: { codeHash: hashToken(code) }, include: { user: true } });
      if (!token || token.usedAt || token.expiresAt <= now) return null;
      if (token.user.status !== 'ACTIVE' || !token.user.emailVerifiedAt) return null;
      const used = await tx.telegramLinkToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) return null;
      const hash = hashToken(String(chatId));
      // Bir sohbet yalnızca bir kullanıcıya bağlı olabilir: önceki sahibin bağı kaldırılır.
      const others = await tx.notificationChannel.findMany({
        where: { type: 'TELEGRAM', externalIdHash: hash, userId: { not: token.userId } },
        select: { id: true, userId: true },
      });
      const previous: Notification[] = [];
      if (others.length > 0) {
        await tx.notificationChannel.deleteMany({ where: { id: { in: others.map((o) => o.id) } } });
        for (const o of others) previous.push(await this.securityNote(tx, o.userId, 'TELEGRAM_UNLINKED', now));
      }
      const data = { config: this.encryptor.encryptJson({ chatId }), externalIdHash: hash, isVerified: true, isEnabled: true };
      await tx.notificationChannel.upsert({
        where: { userId_type: { userId: token.userId, type: 'TELEGRAM' } },
        update: data,
        create: { userId: token.userId, type: 'TELEGRAM', ...data },
      });
      const note = await this.securityNote(tx, token.userId, 'TELEGRAM_LINKED', now);
      return { note, email: token.user.email, previous };
    });
    if (!result) {
      await this.reply(chatId, 'Bağlantı kodu geçersiz veya süresi dolmuş. Panelden yeni bir kod oluşturun.');
      return;
    }
    for (const n of [...result.previous, result.note]) await this.publishNote(n);
    await this.reply(chatId, `✅ ${maskEmail(result.email)} hesabı bağlandı. Eşleşen fırsatlar artık buraya gelecek.`);
  }

  private async onCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const m = /^fav:(\d{1,10})$/.exec(cb.data ?? '');
    const chatId = cb.message?.chat.id;
    if (!m || chatId === undefined) return void (await this.answer(cb.id, 'Geçersiz işlem'));
    const listingId = Number(m[1]);
    if (listingId > 2_147_483_647) return void (await this.answer(cb.id, 'İlan bulunamadı'));
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
