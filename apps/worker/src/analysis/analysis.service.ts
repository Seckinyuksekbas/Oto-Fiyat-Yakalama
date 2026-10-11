import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { analyze } from '@oto/analysis';
import { Prisma } from '@oto/db';
import type { MatchEvent } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { AnalysisSettingsService } from './analysis-settings.service';
import { becameMoreMatchable, deriveEvent, isDamaged, isMatchEvent, materiallyChanged, type AnalysisEvent } from './events';
import { MatchDispatcher } from './match-dispatcher.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Kilit yenilenmez: TTL, tek analizin en kötü süresinden uzundur; aşılırsa latestAnalysisId CAS'ı güvenlik ağıdır. */
const LOCK_TTL_MS = 60_000;
const MAX_CANDIDATES = 1000;
/** Kilidi yalnızca sahibi bırakabilir (token eşleşirse sil). */
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class AnalysisLockBusyError extends Error {
  constructor(listingId: number) {
    super(`İlan ${listingId} şu anda başka bir süreç tarafından analiz ediliyor`);
    this.name = 'AnalysisLockBusyError';
  }
}

export interface AnalyzeOutcome {
  status: 'WRITTEN' | 'UNCHANGED' | 'SKIPPED';
  event: AnalysisEvent | null;
  analysisId: number | null;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: AnalysisSettingsService,
    private readonly matches: MatchDispatcher,
  ) {}

  /** Kilit doluysa AnalysisLockBusyError fırlatır; BullMQ işi geri çekilmeyle yeniden dener. */
  async process(listingId: number, now: Date = new Date()): Promise<AnalyzeOutcome> {
    const lockKey = `lock:analyze:${listingId}`;
    const token = randomUUID();
    if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') throw new AnalysisLockBusyError(listingId);
    try {
      return await this.processLocked(listingId, now);
    } finally {
      // Bırakma hatası asıl sonucu/hatayı maskelememeli; kilit TTL ile kendiliğinden düşer.
      await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token).catch((err: unknown) => this.logger.warn(`Analiz kilidi bırakılamadı (${lockKey}): ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async processLocked(listingId: number, now: Date): Promise<AnalyzeOutcome> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, include: { latestAnalysis: true } });
    if (!listing || listing.status !== 'ACTIVE') return { status: 'SKIPPED', event: null, analysisId: null };

    const settings = await this.settings.get();
    const since = new Date(now.getTime() - settings.poolWindowDays * DAY_MS);
    const [candidates, history] = await Promise.all([
      this.prisma.listing.findMany({
        where: {
          id: { not: listing.id },
          make: listing.make,
          model: listing.model,
          fuel: listing.fuel,
          transmission: listing.transmission,
          year: { gte: listing.year - 3, lte: listing.year + 3 },
          lastSeenAt: { gte: since },
          OR: [{ status: 'ACTIVE' }, { status: 'REMOVED', removedAt: { gte: since } }],
        },
        select: { id: true, title: true, trim: true, year: true, km: true, price: true, damageInfo: true },
        orderBy: { lastSeenAt: 'desc' },
        take: MAX_CANDIDATES,
      }),
      this.prisma.listingPriceHistory.findMany({ where: { listingId }, orderBy: { observedAt: 'asc' }, select: { price: true } }),
    ]);

    const result = analyze(
      {
        id: listing.id,
        trim: listing.trim,
        year: listing.year,
        km: listing.km,
        price: listing.price,
        damaged: isDamaged(listing.damageInfo),
        hadPriceDrop: history.some((h, i) => i > 0 && h.price < history[i - 1].price),
      },
      candidates.map((c) => ({ id: c.id, title: c.title, trim: c.trim, year: c.year, km: c.km, price: c.price, damaged: isDamaged(c.damageInfo) })),
      settings,
    );

    const latest = listing.latestAnalysis;
    const event = deriveEvent(listing, latest);
    if (event === 'REFRESH' && latest && !materiallyChanged(latest, result, settings)) {
      return { status: 'UNCHANGED', event, analysisId: latest.id };
    }

    const matchEvent: MatchEvent | null = isMatchEvent(event)
      ? event
      : (event === 'REFRESH' || event === 'CHANGE') && latest && becameMoreMatchable(latest, result)
        ? 'NEW'
        : null;
    const matchPreviousPrice = event === 'PRICE_DROP' ? (latest?.listingPrice ?? null) : null;
    const analysis = await this.prisma.$transaction(async (tx) => {
      const created = await tx.listingAnalysis.create({
        data: {
          listingId: listing.id,
          engineVersion: result.engineVersion,
          estimatedPrice: result.estimatedPrice,
          priceDiff: result.priceDiff,
          discountPct: result.discountPct === null ? null : new Prisma.Decimal(result.discountPct.toFixed(4)),
          opportunityScore: result.opportunityScore,
          comparableCount: result.comparableCount,
          confidence: result.confidence,
          expansionLevel: result.expansionLevel,
          flags: result.flags,
          explanation: result.explanation as unknown as Prisma.InputJsonValue,
          comparableIds: result.comparableIds,
          listingPrice: listing.price,
          listingContentHash: listing.contentHash,
          matchEvent,
          matchPreviousPrice,
        },
      });
      // Kilit TTL'i dolup başka süreç yazdıysa (CAS): bizim satırı geri al, iş yeniden denensin.
      const swapped = await tx.listing.updateMany({
        where: { id: listing.id, latestAnalysisId: listing.latestAnalysisId },
        data: { latestAnalysisId: created.id },
      });
      if (swapped.count === 0) throw new AnalysisLockBusyError(listing.id);
      return created;
    });

    if (matchEvent) {
      try {
        await this.matches.dispatch({ analysisId: analysis.id, listingId: listing.id, event: matchEvent, previousPrice: matchPreviousPrice });
      } catch (err) {
        // Analiz kalıcı; scheduler kuyruğa alınmamış olayları yeniden gönderir.
        this.logger.warn(`Eşleştirme olayı kuyruğa alınamadı (analiz ${analysis.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: 'WRITTEN', event, analysisId: analysis.id };
  }
}
