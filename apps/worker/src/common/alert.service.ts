import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

export const ALERT_SUPPRESS_SEC = 30 * 60;

export interface Alert {
  /** Susturma anahtarı, ör. `source:3:blocked` */
  key: string;
  level: 'WARN' | 'ERROR';
  component: string;
  message: string;
  context?: Record<string, unknown>;
}

/** Her alarmı SystemLog'a yazar; aynı anahtar için 30 dk'da en fazla bir kez adminlere panel bildirimi gönderir. */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async raise(alert: Alert): Promise<void> {
    await this.prisma.systemLog.create({
      data: {
        level: alert.level,
        component: alert.component,
        message: alert.message,
        context: (alert.context ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    const fresh = await this.redis.set(`alert:${alert.key}`, '1', 'EX', ALERT_SUPPRESS_SEC, 'NX');
    if (fresh !== 'OK') return;
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (admins.length === 0) return;
    await this.prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        kind: 'SYSTEM_ALERT' as const,
        channel: 'IN_APP' as const,
        status: 'SENT' as const,
        sentAt: new Date(),
        payload: { type: 'SYSTEM_ALERT', key: alert.key, level: alert.level, message: alert.message },
      })),
    });
    this.logger.warn(`Alarm (${alert.level}) ${alert.key}: ${alert.message}`);
  }
}
