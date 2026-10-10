import { Inject, Injectable } from '@nestjs/common';
import type { Notification } from '@oto/db';
import { matchNotificationPayloadSchema } from '@oto/shared';
import { Encryptor, hashToken } from '@oto/server-common';
import { classifyTelegramError, isPhotoFallbackError, renderMatchMessage, type TelegramClient } from '@oto/telegram';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../infra/redis.service';
import type { SendResult } from './notify.service';

export const TELEGRAM_CLIENT = Symbol('TELEGRAM_CLIENT');
const CHAT_GAP_MS = 1100;

@Injectable()
export class TelegramAdapter {
  constructor(
    @Inject(TELEGRAM_CLIENT) private readonly client: TelegramClient | null,
    private readonly encryptor: Encryptor,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async send(n: Notification, channelConfig: string): Promise<SendResult> {
    if (!this.client) return { kind: 'PERMANENT', error: 'TELEGRAM_DISABLED' };
    const { chatId } = this.encryptor.decryptJson<{ chatId: number }>(channelConfig);
    const parsed = matchNotificationPayloadSchema.safeParse(n.payload);
    if (!parsed.success) return { kind: 'PERMANENT', error: 'INVALID_PAYLOAD' };
    // Sohbet başına 1 msj/sn (spec §5.4); kilit alınamazsa deneme hakkı yemeden ertele.
    const gate = await this.redis.set(`tg:chat:${hashToken(String(chatId))}`, '1', 'PX', CHAT_GAP_MS, 'NX');
    if (gate !== 'OK') return { kind: 'THROTTLED', retryAfterMs: CHAT_GAP_MS };
    const msg = renderMatchMessage(parsed.data, { publicBaseUrl: this.env.PUBLIC_BASE_URL });
    try {
      if (msg.photoUrl) {
        try {
          await this.client.sendPhoto(chatId, msg.photoUrl, msg.text, msg.replyMarkup);
          return { kind: 'SENT' };
        } catch (err) {
          if (!isPhotoFallbackError(err)) throw err;
        }
      }
      await this.client.sendMessage(chatId, msg.text, msg.replyMarkup);
      return { kind: 'SENT' };
    } catch (err) {
      const c = classifyTelegramError(err);
      return c.kind === 'RETRYABLE'
        ? { kind: 'RETRYABLE', error: c.error, retryAfterMs: c.retryAfterMs }
        : { kind: 'PERMANENT', error: c.error, disableChannel: c.disableChannel };
    }
  }
}
