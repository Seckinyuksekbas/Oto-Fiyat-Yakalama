import { Injectable, Logger } from '@nestjs/common';
import { startOfIstanbulDay } from '@oto/shared';
import { MatchDispatcher } from '../analysis/match-dispatcher.service';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RETRYING_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export const NIGHTLY_HOUR_ISTANBUL = 3;
export const MATCH_REQUEUE_AFTER_MS = 60_000;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const PAGE = 500;

export function istanbulDayKey(d: Date): string {
  const local = new Date(startOfIstanbulDay(d).getTime() + ISTANBUL_OFFSET_MS);
  return local.toISOString().slice(0, 10).replace(/-/g, '');
}

export function istanbulHour(d: Date): number {
  return (d.getUTCHours() + 3) % 24;
}

@Injectable()
export class AnalysisSweepService {
  private readonly logger = new Logger(AnalysisSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
    private readonly matches: MatchDispatcher,
  ) {}

  /** İstanbul saatiyle 03:00'ten sonra günde bir kez tüm aktif ilanlar için REFRESH işi üretir. */
  async maybeRunNightly(now: Date = new Date()): Promise<number> {
    if (istanbulHour(now) < NIGHTLY_HOUR_ISTANBUL) return 0;
    const dayKey = istanbulDayKey(now);
    const claimed = await this.redis.set(`analysis:nightly:${dayKey}`, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') return 0;
    const n = await this.enqueueRefreshAll(dayKey);
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
          opts: { jobId: `analyze-refresh-${r.id}-${dayKey}`, ...RETRYING_JOB_OPTS },
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
      where: { matchEvent: { not: null }, matchQueuedAt: null, createdAt: { lt: new Date(now.getTime() - MATCH_REQUEUE_AFTER_MS) } },
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
        this.logger.warn(`Eşleştirme olayı yeniden gönderilemedi (analiz ${p.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return sent;
  }
}
