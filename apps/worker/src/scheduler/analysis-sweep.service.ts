import { Injectable, Logger } from '@nestjs/common';
import { ISTANBUL_OFFSET_MS, MATCH_DISPATCH_MAX_ATTEMPTS, matchDispatchStuckFlagKey, startOfIstanbulDay } from '@oto/shared';
import { AlertService } from '../common/alert.service';
import { MatchDispatcher } from '../analysis/match-dispatcher.service';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RETRYING_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export const NIGHTLY_HOUR_ISTANBUL = 3;
export const MATCH_REQUEUE_AFTER_MS = 60_000;
/** Bu kadar başarısız yeniden gönderimden sonra satır atlanır (head-of-line engeli) ve bir kez alarm verilir. */
export { MATCH_DISPATCH_MAX_ATTEMPTS };
const PAGE = 500;
/** Gece yenilemesi gerçek zamanlı analizlerden düşük öncelikli (BullMQ: büyük sayı = geç). */
export const REFRESH_PRIORITY = 100;

export function istanbulDayKey(d: Date): string {
  const local = new Date(startOfIstanbulDay(d).getTime() + ISTANBUL_OFFSET_MS);
  return local.toISOString().slice(0, 10).replace(/-/g, '');
}

export function istanbulHour(d: Date): number {
  return new Date(d.getTime() + ISTANBUL_OFFSET_MS).getUTCHours();
}

@Injectable()
export class AnalysisSweepService {
  private readonly logger = new Logger(AnalysisSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
    private readonly matches: MatchDispatcher,
    private readonly alerts: AlertService,
  ) {}

  /** İstanbul saatiyle 03:00'ten sonra günde bir kez tüm aktif ilanlar için REFRESH işi üretir. */
  async maybeRunNightly(now: Date = new Date()): Promise<number> {
    if (istanbulHour(now) < NIGHTLY_HOUR_ISTANBUL) return 0;
    const dayKey = istanbulDayKey(now);
    const key = `analysis:nightly:${dayKey}`;
    const claimed = await this.redis.set(key, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') return 0;
    let n: number;
    try {
      n = await this.enqueueRefreshAll(dayKey);
    } catch (err) {
      await this.redis.del(key); // iş id'leri güne özgü olduğundan yeniden deneme güvenlidir
      throw err;
    }
    this.logger.log(`Gece yeniden analizi: ${n} ilan kuyruğa eklendi (${dayKey})`);
    return n;
  }

  async enqueueRefreshAll(dayKey: string): Promise<number> {
    let cursor = 0;
    let total = 0;
    for (;;) {
      const rows = await this.prisma.listing.findMany({
        where: { status: 'ACTIVE', id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: PAGE,
        select: { id: true },
      });
      if (rows.length === 0) break;
      await this.queues.analyze.addBulk(
        rows.map((r) => ({
          name: 'analyze',
          data: { listingId: r.id, reason: 'REFRESH' as const },
          opts: { jobId: `analyze-refresh-${r.id}-${dayKey}`, priority: REFRESH_PRIORITY, ...RETRYING_JOB_OPTS },
        })),
      );
      total += rows.length;
      cursor = rows[rows.length - 1].id;
    }
    return total;
  }

  /** Commit sonrası kuyruğa alınamamış eşleştirme olaylarını yeniden gönderir. */
  async requeuePendingMatches(now: Date = new Date()): Promise<number> {
    const pending = await this.prisma.listingAnalysis.findMany({
      where: { matchEvent: { in: ['NEW', 'PRICE_DROP', 'RELIST'] }, matchQueuedAt: null, matchDispatchAttempts: { lt: MATCH_DISPATCH_MAX_ATTEMPTS }, createdAt: { lt: new Date(now.getTime() - MATCH_REQUEUE_AFTER_MS) } },
      orderBy: { id: 'asc' },
      take: PAGE,
      select: { id: true, listingId: true, matchEvent: true, matchPreviousPrice: true },
    });
    let sent = 0;
    for (const p of pending) {
      try {
        await this.matches.dispatch({ analysisId: p.id, listingId: p.listingId, event: p.matchEvent!, previousPrice: p.matchPreviousPrice });
        sent += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Eşleştirme olayı yeniden gönderilemedi (analiz ${p.id}): ${reason}`);
        await this.recordDispatchFailure(p.id, reason);
      }
    }
    await this.alertStuck();
    return sent;
  }

  private async recordDispatchFailure(analysisId: number, reason: string): Promise<void> {
    try {
      await this.prisma.listingAnalysis.update({ where: { id: analysisId }, data: { matchDispatchAttempts: { increment: 1 } } });
    } catch (err) {
      this.logger.warn(`Deneme sayacı güncellenemedi (analiz ${analysisId}, ${reason}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Sınıra ulaşmış satırlar için bir kez `match-dispatch-stuck` alarmı. Alarm teslimi başarısız olursa işaret konmaz
   * ve bir sonraki süpürmede yeniden denenir.
   */
  private async alertStuck(): Promise<void> {
    const stuck = await this.prisma.listingAnalysis.findMany({
      where: { matchEvent: { in: ['NEW', 'PRICE_DROP', 'RELIST'] }, matchQueuedAt: null, matchDispatchAttempts: { gte: MATCH_DISPATCH_MAX_ATTEMPTS } },
      orderBy: { id: 'asc' },
      take: 50,
      select: { id: true, listingId: true },
    });
    for (const row of stuck) {
      const flag = matchDispatchStuckFlagKey(row.id);
      try {
        if ((await this.redis.exists(flag)) === 1) continue;
        await this.alerts.raise({
          key: `match-dispatch-stuck:${row.id}`,
          level: 'ERROR',
          component: 'analysis-sweep',
          message: `match-dispatch-stuck: analiz ${row.id} (ilan ${row.listingId}) eşleştirme kuyruğuna ${MATCH_DISPATCH_MAX_ATTEMPTS} denemede alınamadı`,
          context: { analysisId: row.id, listingId: row.listingId },
        });
        await this.redis.set(flag, '1', 'EX', 30 * 24 * 60 * 60);
      } catch (err) {
        this.logger.warn(`Takılı eşleştirme alarmı verilemedi (analiz ${row.id}); sonraki süpürmede yeniden denenecek: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
