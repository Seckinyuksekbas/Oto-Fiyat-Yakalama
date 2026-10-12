import { Injectable, Logger } from '@nestjs/common';
import { maxSearchProfilesFor, resolveUserPlan } from '@oto/db';
import { userEventChannel, type UserEvent } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { boundLocks, LOCK_TX_OPTIONS } from '../infra/tx-options';
import { istanbulDayKey } from './analysis-sweep.service';

export interface SubscriptionSweepResult {
  expired: number;
  paused: number;
}

/** Önceki çalıştırmada yarım kalmış (EXPIRED ama profilleri hâlâ fazla) kullanıcıları onarmak için geriye bakış. */
const REPAIR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Başarısız süpürmeden sonra yeniden deneme aralığı: gün işareti silinmez, bu kısa ömre düşürülür (her tick'te denenmez). */
export const SUBSCRIPTION_SWEEP_RETRY_SEC = 10 * 60;

interface UserOutcome extends SubscriptionSweepResult {
  event?: { userId: string; event: UserEvent };
}

/** Süresi dolan abonelikleri kapatır; yeni limite sığmayan ACTIVE profilleri (en yeniden başlayarak) duraklatır. */
@Injectable()
export class SubscriptionSweepService {
  private readonly logger = new Logger(SubscriptionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * İstanbul gününde bir kez çalışır (Redis NX); bugün zaten çalıştıysa null döner.
   * Herhangi bir kullanıcı başarısız olursa diğerleri yine işlenir ve hata fırlatılır (scheduler deneme başına bir kez loglar).
   * Gün işareti silinmez; ömrü SUBSCRIPTION_SWEEP_RETRY_SEC'e (10 dk) düşürülür: hata sürerken her tick'te yeniden
   * denenmez, süre dolunca sonraki tick yalnızca eksik kalanları onarır (işlem kullanıcı başına idempotenttir).
   */
  async run(now: Date = new Date()): Promise<SubscriptionSweepResult | null> {
    const key = `subs:sweep:${istanbulDayKey(now)}`;
    const claimed = await this.redis.set(key, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') return null;
    try {
      return await this.sweep(now);
    } catch (err) {
      await this.redis.set(key, 'retry', 'EX', SUBSCRIPTION_SWEEP_RETRY_SEC).catch(() => undefined);
      throw err;
    }
  }

  private async sweep(now: Date): Promise<SubscriptionSweepResult> {
    const [lapsed, repair] = await Promise.all([
      this.prisma.userSubscription.findMany({ where: { status: 'ACTIVE', endsAt: { lte: now } }, select: { userId: true } }),
      this.prisma.userSubscription.findMany({
        where: { status: 'EXPIRED', endsAt: { gte: new Date(now.getTime() - REPAIR_LOOKBACK_MS) }, user: { searchProfiles: { some: { status: 'ACTIVE' } } } },
        select: { userId: true },
      }),
    ]);
    const userIds = [...new Set([...lapsed, ...repair].map((s) => s.userId))];
    const total: SubscriptionSweepResult = { expired: 0, paused: 0 };
    const failures: string[] = [];
    for (const userId of userIds) {
      try {
        const out = await this.processUser(userId, now);
        total.expired += out.expired;
        total.paused += out.paused;
        if (out.event) {
          // Yayın commit'ten sonra; başarısızlığı sonucu değiştirmez.
          await this.redis.publish(userEventChannel(userId), JSON.stringify(out.event.event)).catch((err: unknown) => this.logger.warn(`Bildirim yayınlanamadı: ${String(err)}`));
        }
      } catch (err) {
        failures.push(userId);
        this.logger.error(`Kullanıcı ${userId} abonelik süpürmesi başarısız: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Abonelik süpürmesi: ${total.expired} abonelik süresi doldu, ${total.paused} profil duraklatıldı`);
    if (failures.length > 0) throw new Error(`Abonelik süpürmesi ${failures.length} kullanıcıda başarısız oldu`);
    return total;
  }

  /**
   * Tek kullanıcı, tek transaction: süresi dolanları kapat + fazla profilleri duraklat + bildirimi yaz.
   * Kullanıcı satırı kilitlendiği için tx sınırlıdır (LOCK_TX_OPTIONS + boundLocks): kilit tutulursa 5 sn'de 55P03 ile
   * düşer, kullanıcı başarısız sayılır ve süpürme kısa bekleme sonrası yeniden dener.
   */
  private async processUser(userId: string, now: Date): Promise<UserOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await boundLocks(tx);
      // Eşzamanlı profil oluşturma/aktifleştirme ile yarışmamak için kullanıcı satırını kilitle.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const expired = await tx.userSubscription.updateMany({ where: { userId, status: 'ACTIVE', endsAt: { lte: now } }, data: { status: 'EXPIRED' } });
      const user = await tx.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
      if (!user) return { expired: expired.count, paused: 0 };
      const plan = await resolveUserPlan(tx, userId, now);
      const limit = maxSearchProfilesFor(plan.limits, user.emailVerifiedAt !== null);
      const active = await tx.searchProfile.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      const excess = active.slice(limit);
      if (excess.length === 0) return { expired: expired.count, paused: 0 };
      await tx.searchProfile.updateMany({ where: { id: { in: excess.map((p) => p.id) }, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
      const message = `Aboneliğinizin süresi doldu; ${plan.planName} planı en fazla ${limit} aktif profile izin veriyor. ${excess.length} profil duraklatıldı.`;
      const note = await tx.notification.create({
        data: {
          userId, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', sentAt: now,
          payload: { type: 'SUBSCRIPTION_EXPIRED', level: 'WARN', message, pausedProfiles: excess.length },
        },
      });
      const event: UserEvent = {
        type: 'notification',
        notification: { id: note.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: note.payload, createdAt: note.createdAt.toISOString() },
      };
      return { expired: expired.count, paused: excess.length, event: { userId, event } };
    }, LOCK_TX_OPTIONS);
  }
}
