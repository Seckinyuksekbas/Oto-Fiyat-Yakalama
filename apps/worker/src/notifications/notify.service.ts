import { Injectable, Logger } from '@nestjs/common';
import { resolveUserPlan } from '@oto/db';
import { redactSecrets } from '@oto/server-common';
import { userEventChannel, type UserEvent } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { InAppAdapter } from './in-app.adapter';
import { TelegramAdapter } from './telegram.adapter';

export type SendResult =
  | { kind: 'SENT' }
  | { kind: 'RETRYABLE'; error: string; retryAfterMs?: number }
  | { kind: 'PERMANENT'; error: string; disableChannel?: boolean }
  | { kind: 'THROTTLED'; retryAfterMs: number };

export type NotifyResult =
  | { kind: 'DONE'; status: 'SENT' | 'FAILED' | 'SKIPPED' }
  | { kind: 'RETRY'; error: string; retryAfterMs?: number }
  | { kind: 'THROTTLED'; retryAfterMs: number };

/** Kalıcılaştırılan hata metinleri: bot token / URL kimlik bilgisi / sorgu dizisi ayıklanır, 500 karakter. */
const short = (s: string) => redactSecrets(s).slice(0, 500);

/** Teslim hatası sayılmayan atlama: SYSTEM_ALERT alıcısı artık admin değil (izleme hata oranına girmez). */
export const NOT_ADMIN = 'NOT_ADMIN';

/** Telegram 401 (geçersiz bot token) görüldüğünde konur; MonitorService `telegram:unauthorized` alarmını buradan üretir. */
export const TELEGRAM_UNAUTHORIZED_FLAG = 'telegram:unauthorized:at';
const TELEGRAM_UNAUTHORIZED_FLAG_SEC = 60 * 60;

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly inApp: InAppAdapter,
    private readonly telegram: TelegramAdapter,
  ) {}

  async process(notificationId: number, attempt: { attemptsMade: number; maxAttempts: number }): Promise<NotifyResult> {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId }, include: { user: { select: { id: true, status: true, role: true } } } });
    if (!n || n.status !== 'PENDING') return { kind: 'DONE', status: 'SKIPPED' };
    if (n.user.status !== 'ACTIVE') return this.fail(n.id, 'USER_INACTIVE');
    // Sistem alarmı personel bildirimidir: kuyruğa alındıktan sonra yetkisi alınan kullanıcıya gönderilmez.
    if (n.kind === 'SYSTEM_ALERT' && n.user.role !== 'ADMIN' && n.user.role !== 'SUPER_ADMIN') return this.fail(n.id, NOT_ADMIN);

    let result: SendResult;
    if (n.channel === 'IN_APP') {
      result = await this.inApp.send(n);
    } else if (n.channel === 'TELEGRAM') {
      const channel = await this.prisma.notificationChannel.findUnique({ where: { userId_type: { userId: n.userId, type: 'TELEGRAM' } } });
      const plan = await resolveUserPlan(this.prisma, n.userId);
      // Sistem alarmları personel bildirimidir: paket kanal kısıtı uygulanmaz (yalnızca doğrulanmış/etkin kanal şartı).
      const planAllows = n.kind === 'SYSTEM_ALERT' || plan.limits.channels.includes('TELEGRAM');
      if (!channel?.config || !channel.isEnabled || !channel.isVerified || !planAllows) {
        return this.fail(n.id, 'CHANNEL_UNAVAILABLE');
      }
      result = await this.telegram.send(n, channel.config);
    } else {
      return this.fail(n.id, 'UNSUPPORTED_CHANNEL');
    }

    if (result.kind === 'THROTTLED') return result;
    if (result.kind === 'SENT') {
      const sentAt = new Date();
      const p = n.payload as { eventAt?: string; listing?: { firstSeenAt?: string } } | null;
      // Gecikme olay anından ölçülür; eventAt'siz eski satırlarda ilanın ilk görülme anına düşer.
      const eventTime = Date.parse(p?.eventAt ?? p?.listing?.firstSeenAt ?? '');
      const upd = await this.prisma.notification.updateMany({
        where: { id: n.id, status: 'PENDING' },
        data: { status: 'SENT', sentAt, attempts: { increment: 1 }, lastError: null, latencyMs: Number.isFinite(eventTime) ? sentAt.getTime() - eventTime : null },
      });
      return { kind: 'DONE', status: upd.count > 0 ? 'SENT' : 'SKIPPED' };
    }
    if (result.kind === 'PERMANENT') {
      if (result.disableChannel) await this.disableTelegram(n.userId, result.error);
      if (result.error.includes('(401)')) {
        this.logger.error('Telegram bot token geçersiz');
        await this.redis
          .set(TELEGRAM_UNAUTHORIZED_FLAG, new Date().toISOString(), 'EX', TELEGRAM_UNAUTHORIZED_FLAG_SEC)
          .catch((err: unknown) => this.logger.warn(`401 işareti yazılamadı: ${String(err)}`));
      }
      return this.fail(n.id, result.error);
    }
    // RETRYABLE
    const last = attempt.attemptsMade + 1 >= attempt.maxAttempts;
    if (last) return this.fail(n.id, result.error);
    await this.prisma.notification.update({ where: { id: n.id }, data: { attempts: { increment: 1 }, lastError: short(result.error) } });
    return { kind: 'RETRY', error: result.error, retryAfterMs: result.retryAfterMs };
  }

  /** İşlenmeyen beklenmedik hata: deneme sayılır; son denemede satır FAILED olur (PENDING'de takılı kalmaz). */
  async recordUnexpectedFailure(id: number, err: unknown, attempt: { attemptsMade: number; maxAttempts: number }): Promise<void> {
    const msg = short(err instanceof Error ? err.message : String(err));
    if (attempt.attemptsMade + 1 >= attempt.maxAttempts) {
      await this.prisma.notification.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: msg } });
    } else {
      await this.prisma.notification.updateMany({ where: { id, status: 'PENDING' }, data: { attempts: { increment: 1 }, lastError: msg } });
    }
  }

  private async fail(id: number, error: string): Promise<NotifyResult> {
    await this.prisma.notification.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: short(error) } });
    return { kind: 'DONE', status: 'FAILED' };
  }

  /** Bot engellendi / sohbet yok: kanal kapatılır, kullanıcı panelde uyarılır (spec §5.4). */
  private async disableTelegram(userId: string, reason: string): Promise<void> {
    const res = await this.prisma.notificationChannel.updateMany({ where: { userId, type: 'TELEGRAM', isEnabled: true }, data: { isEnabled: false } });
    if (res.count === 0) return;
    const warn = await this.prisma.notification.create({
      data: { userId, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', sentAt: new Date(), payload: { type: 'TELEGRAM_DISABLED', reason: short(reason) } },
    });
    const event: UserEvent = {
      type: 'notification',
      notification: { id: warn.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: warn.payload, createdAt: warn.createdAt.toISOString() },
    };
    await this.redis.publish(userEventChannel(userId), JSON.stringify(event)).catch((err: unknown) => this.logger.warn(`Uyarı yayınlanamadı: ${String(err)}`));
    this.logger.warn(`Kullanıcı ${userId} Telegram kanalı kapatıldı: ${reason}`);
  }
}
