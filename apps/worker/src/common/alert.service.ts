import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import { ADMIN_EVENTS_CHANNEL, adminAlertEventSchema, alertDedupeKey, userEventChannel, type SystemAlertPayload, type UserEvent } from '@oto/shared';
import { redactSecrets } from '@oto/server-common';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';

export const ALERT_SUPPRESS_SEC = 30 * 60;
/** Kalıcı kaynak durumları (DOWN / engel) için yeniden bildirim aralığı; SourceHealthService ve MonitorService aynı değeri kullanır. */
export const PERSISTENT_ALERT_TTL_SEC = 6 * 60 * 60;
const MAX_KEY = 200;
const MAX_MESSAGE = 4000;

export interface Alert {
  /** Susturma anahtarı, ör. `source:3:blocked` */
  key: string;
  level: 'WARN' | 'ERROR';
  component: string;
  message: string;
  context?: Record<string, unknown>;
  /**
   * true: SystemLog da (ayrı `alert-log:<key>` anahtarıyla) susturulur — her tick'te yeniden değerlendirilen koşullar
   * (MonitorService) için; admin yokken bile her tick'te log yazılmaz. Olay tabanlı çağıranlar varsayılanı (her olay loglanır) kullanır.
   */
  dedupeLog?: boolean;
  /** Yeniden bildirim aralığı (sn); varsayılan 30 dk. Kalıcı durumlar (kaynak DOWN/engel) daha uzun aralık kullanır. */
  ttlSec?: number;
}

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

/** SystemLog bağlamındaki tüm metinler (iç içe dahil) yazım anında maskelenir; okuma tarafındaki maskeleme ek savunmadır. */
function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)]));
  return value;
}

/**
 * Alarm teslimi (spec §9): SystemLog + aktif adminlere IN_APP `SYSTEM_ALERT` (`user:<id>` yayını) + `admin:events` yayını +
 * Telegram kanalı doğrulanmış/etkin aktif adminlere TELEGRAM satırı (PENDING, NotificationDispatcher ile `notify-telegram`).
 * Aynı anahtar susturma süresi içinde en fazla bir kez teslim edilir; susturma Redis `SET NX EX` ile atomiktir (birden çok
 * scheduler örneği aynı anda yükseltse de tek teslim).
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  /** true: bu çağrı alarmı teslim etti; false: susturuldu ya da teslim edilecek admin yok. */
  async raise(input: Alert): Promise<boolean> {
    const alert = { ...input, key: input.key.slice(0, MAX_KEY), message: input.message.slice(0, MAX_MESSAGE) };
    const ttl = alert.ttlSec ?? ALERT_SUPPRESS_SEC;
    if (!alert.dedupeLog) await this.log(alert);
    else if ((await this.redis.set(`alert-log:${alert.key}`, '1', 'EX', ttl, 'NX')) === 'OK') await this.log(alert);

    const suppressKey = alertDedupeKey(alert.key);
    const fresh = await this.redis.set(suppressKey, '1', 'EX', ttl, 'NX');
    if (fresh !== 'OK') return false;
    const at = new Date();
    let inApp: Array<{ id: number; userId: string; payload: Prisma.JsonValue; createdAt: Date }>;
    let telegramIds: number[];
    try {
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
    if (telegramIds.length > 0) {
      await this.dispatcher
        .enqueue(telegramIds.map((id) => ({ id, channel: 'TELEGRAM' })))
        .catch((err: unknown) => this.logger.warn(`Alarm Telegram bildirimleri kuyruğa alınamadı (süpürme yeniden deneyecek): ${err instanceof Error ? err.message : String(err)}`));
    }
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
        context: (alert.context ? redactStrings(alert.context) : undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private async publish(alert: Alert, at: Date, inApp: Array<{ id: number; userId: string; payload: Prisma.JsonValue; createdAt: Date }>): Promise<void> {
    const pipeline = this.redis.pipeline();
    const event = adminAlertEventSchema.safeParse({ type: 'alert', key: alert.key, level: alert.level, message: alert.message, at: at.toISOString() });
    if (event.success) pipeline.publish(ADMIN_EVENTS_CHANNEL, JSON.stringify(event.data));
    else this.logger.warn(`Geçersiz admin alarm olayı yayınlanmadı (${alert.key}): ${event.error.issues.map((i) => i.path.join('.')).join(', ')}`);
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
