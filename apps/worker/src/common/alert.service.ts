import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import { ADMIN_EVENTS_CHANNEL, notifyJobId, userEventChannel, type AdminEvent, type SystemAlertPayload, type UserEvent } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { NOTIFY_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export const ALERT_SUPPRESS_SEC = 30 * 60;

export interface Alert {
  /** Susturma anahtarı, ör. `source:3:blocked` */
  key: string;
  level: 'WARN' | 'ERROR';
  component: string;
  message: string;
  context?: Record<string, unknown>;
  /**
   * true: SystemLog da susturmaya tabidir (yalnızca teslim edilen alarm loglanır). Her tick'te yeniden değerlendirilen
   * koşullar (MonitorService) için; olay tabanlı çağıranlar varsayılanı (her olay loglanır) kullanır.
   */
  dedupeLog?: boolean;
}

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

/**
 * Alarm teslimi (spec §9): SystemLog + aktif adminlere IN_APP `SYSTEM_ALERT` (`user:<id>` yayını) + `admin:events` yayını +
 * Telegram kanalı doğrulanmış/etkin aktif adminlere TELEGRAM satırı (PENDING, `notify-telegram` kuyruğu).
 * Aynı anahtar 30 dk'da en fazla bir kez teslim edilir; susturma Redis `SET NX EX` ile atomiktir (birden çok scheduler
 * örneği aynı anda yükseltse de tek teslim).
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
  ) {}

  /** true: bu çağrı alarmı teslim etti; false: susturuldu ya da teslim edilecek admin yok. */
  async raise(alert: Alert): Promise<boolean> {
    if (!alert.dedupeLog) await this.log(alert);
    const suppressKey = `alert:${alert.key}`;
    const fresh = await this.redis.set(suppressKey, '1', 'EX', ALERT_SUPPRESS_SEC, 'NX');
    if (fresh !== 'OK') return false;
    const at = new Date();
    let inApp: Array<{ id: number; userId: string; payload: Prisma.JsonValue; createdAt: Date }>;
    let telegramIds: number[];
    try {
      if (alert.dedupeLog) await this.log(alert);
      const admins = await this.prisma.user.findMany({
        where: { role: { in: [...ADMIN_ROLES] }, status: 'ACTIVE' },
        select: { id: true, channels: { where: { type: 'TELEGRAM', isVerified: true, isEnabled: true, config: { not: null } }, select: { id: true } } },
      });
      if (admins.length === 0) {
        // Teslim edilmedi: sonradan eklenen bir admin bu alarmı yine de alabilsin.
        await this.redis.del(suppressKey);
        return false;
      }
      const payload: SystemAlertPayload = { type: 'SYSTEM_ALERT', key: alert.key, level: alert.level, message: alert.message, at: at.toISOString() };
      ({ inApp, telegramIds } = await this.prisma.$transaction(async (tx) => {
        const inAppRows = await tx.notification.createManyAndReturn({
          data: admins.map((a) => ({ userId: a.id, kind: 'SYSTEM_ALERT' as const, channel: 'IN_APP' as const, status: 'SENT' as const, sentAt: at, payload })),
          select: { id: true, userId: true, payload: true, createdAt: true },
        });
        const tgAdmins = admins.filter((a) => a.channels.length > 0);
        const tgRows = tgAdmins.length
          ? await tx.notification.createManyAndReturn({
              data: tgAdmins.map((a) => ({ userId: a.id, kind: 'SYSTEM_ALERT' as const, channel: 'TELEGRAM' as const, status: 'PENDING' as const, payload })),
              select: { id: true },
            })
          : [];
        return { inApp: inAppRows, telegramIds: tgRows.map((r) => r.id) };
      }));
    } catch (err) {
      await this.redis.del(suppressKey).catch(() => undefined);
      throw err;
    }
    // Satırlar yazıldı: buradan sonrası en iyi çaba (kuyruğa alınamayan TELEGRAM satırlarını bildirim süpürmesi toplar).
    await this.enqueueTelegram(telegramIds);
    await this.publish(alert, at, inApp);
    this.logger.warn(`Alarm (${alert.level}) ${alert.key}: ${alert.message}`);
    return true;
  }

  private async log(alert: Alert): Promise<void> {
    await this.prisma.systemLog.create({
      data: {
        level: alert.level,
        component: alert.component,
        message: alert.message,
        context: (alert.context ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private async enqueueTelegram(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.queues.notifyTelegram.addBulk(ids.map((id) => ({ name: 'notify', data: { notificationId: id }, opts: { jobId: notifyJobId(id), ...NOTIFY_JOB_OPTS } })));
      await this.prisma.notification.updateMany({ where: { id: { in: ids } }, data: { queuedAt: new Date() } });
    } catch (err) {
      this.logger.warn(`Alarm Telegram bildirimleri kuyruğa alınamadı (süpürme yeniden deneyecek): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async publish(alert: Alert, at: Date, inApp: Array<{ id: number; userId: string; payload: Prisma.JsonValue; createdAt: Date }>): Promise<void> {
    const event: AdminEvent = { type: 'alert', key: alert.key, level: alert.level, message: alert.message.slice(0, 4000), at: at.toISOString() };
    const pipeline = this.redis.pipeline().publish(ADMIN_EVENTS_CHANNEL, JSON.stringify(event));
    for (const n of inApp) {
      const ue: UserEvent = {
        type: 'notification',
        notification: { id: n.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: n.payload, createdAt: n.createdAt.toISOString() },
      };
      pipeline.publish(userEventChannel(n.userId), JSON.stringify(ue));
    }
    await pipeline.exec().catch((err: unknown) => this.logger.warn(`Alarm yayınlanamadı: ${err instanceof Error ? err.message : String(err)}`));
  }
}
