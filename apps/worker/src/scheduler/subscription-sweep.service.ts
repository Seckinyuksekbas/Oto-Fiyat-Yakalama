import { Injectable, Logger } from '@nestjs/common';
import { resolveUserPlan } from '@oto/db';
import { userEventChannel, type UserEvent } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { istanbulDayKey } from './analysis-sweep.service';

export interface SubscriptionSweepResult {
  expired: number;
  paused: number;
}

/** Süresi dolan abonelikleri kapatır; yeni limite sığmayan ACTIVE profilleri (en yeniden başlayarak) duraklatır. */
@Injectable()
export class SubscriptionSweepService {
  private readonly logger = new Logger(SubscriptionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** İstanbul gününde bir kez çalışır (Redis NX); bugün zaten çalıştıysa null döner. Hata olursa işaret serbest bırakılır. */
  async run(now: Date = new Date()): Promise<SubscriptionSweepResult | null> {
    const key = `subs:sweep:${istanbulDayKey(now)}`;
    const claimed = await this.redis.set(key, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') return null;
    try {
      return await this.sweep(now);
    } catch (err) {
      await this.redis.del(key).catch(() => undefined);
      throw err;
    }
  }

  private async sweep(now: Date): Promise<SubscriptionSweepResult> {
    const lapsed = await this.prisma.userSubscription.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: now } },
      select: { id: true, userId: true },
    });
    if (lapsed.length === 0) return { expired: 0, paused: 0 };
    const upd = await this.prisma.userSubscription.updateMany({
      where: { id: { in: lapsed.map((s) => s.id) }, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    let paused = 0;
    for (const userId of new Set(lapsed.map((s) => s.userId))) {
      try {
        paused += await this.enforceProfileLimit(userId, now);
      } catch (err) {
        this.logger.error(`Kullanıcı ${userId} profil limiti uygulanamadı: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Abonelik süpürmesi: ${upd.count} abonelik süresi doldu, ${paused} profil duraklatıldı`);
    return { expired: upd.count, paused };
  }

  private async enforceProfileLimit(userId: string, now: Date): Promise<number> {
    const plan = await resolveUserPlan(this.prisma, userId, now);
    const limit = plan.limits.maxSearchProfiles;
    const active = await this.prisma.searchProfile.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const excess = active.slice(limit);
    if (excess.length === 0) return 0;
    await this.prisma.searchProfile.updateMany({ where: { id: { in: excess.map((p) => p.id) }, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
    const message = `Aboneliğinizin süresi doldu; ${plan.planName} planı en fazla ${limit} aktif profile izin veriyor. ${excess.length} profil duraklatıldı.`;
    const note = await this.prisma.notification.create({
      data: {
        userId, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', sentAt: now,
        payload: { type: 'SUBSCRIPTION_EXPIRED', level: 'WARN', message, pausedProfiles: excess.length },
      },
    });
    const event: UserEvent = {
      type: 'notification',
      notification: { id: note.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: note.payload, createdAt: note.createdAt.toISOString() },
    };
    await this.redis.publish(userEventChannel(userId), JSON.stringify(event)).catch((err: unknown) => this.logger.warn(`Bildirim yayınlanamadı: ${String(err)}`));
    return excess.length;
  }
}
