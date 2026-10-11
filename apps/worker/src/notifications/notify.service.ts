import { Injectable, Logger } from '@nestjs/common';
import { resolveUserPlan } from '@oto/db';
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

const short = (s: string) => s.slice(0, 500);

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
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId }, include: { user: { select: { id: true, status: true } } } });
    if (!n || n.status !== 'PENDING') return { kind: 'DONE', status: 'SKIPPED' };
    if (n.user.status !== 'ACTIVE') return this.fail(n.id, 'USER_INACTIVE');

    let result: SendResult;
    if (n.channel === 'IN_APP') {
      result = await this.inApp.send(n);
    } else if (n.channel === 'TELEGRAM') {
      const channel = await this.prisma.notificationChannel.findUnique({ where: { userId_type: { userId: n.userId, type: 'TELEGRAM' } } });
      const plan = await resolveUserPlan(this.prisma, n.userId);
      if (!channel?.config || !channel.isEnabled || !channel.isVerified || !plan.limits.channels.includes('TELEGRAM')) {
        return this.fail(n.id, 'CHANNEL_UNAVAILABLE');
      }
      result = await this.telegram.send(n, channel.config);
    } else {
      return this.fail(n.id, 'UNSUPPORTED_CHANNEL');
    }

    if (result.kind === 'THROTTLED') return result;
    if (result.kind === 'SENT') {
      const sentAt = new Date();
      const firstSeen = Date.parse((n.payload as { listing?: { firstSeenAt?: string } })?.listing?.firstSeenAt ?? '');
      const upd = await this.prisma.notification.updateMany({
        where: { id: n.id, status: 'PENDING' },
        data: { status: 'SENT', sentAt, attempts: { increment: 1 }, lastError: null, latencyMs: Number.isFinite(firstSeen) ? sentAt.getTime() - firstSeen : null },
      });
      return { kind: 'DONE', status: upd.count > 0 ? 'SENT' : 'SKIPPED' };
    }
    if (result.kind === 'PERMANENT') {
      if (result.disableChannel) await this.disableTelegram(n.userId, result.error);
      if (result.error.includes('(401)')) this.logger.error('Telegram bot token geçersiz');
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
    const msg = short((err instanceof Error ? err.message : String(err)).replace(/bot\d+:[\w-]+/g, 'bot[redacted]'));
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
