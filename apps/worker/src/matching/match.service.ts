import { Injectable, Logger } from '@nestjs/common';
import { findMatchingProfiles, type ListingFacts } from '@oto/db';
import type { MatchEvent, MatchJobData } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { planNotifications, type PlannedMatch, type PlannedNotification } from '../notifications/notification-planner';
import { decideMatchReason } from './decide';

/** pg_advisory_xact_lock(ad alanı, ilan id): aynı ilanın eşleştirmesi tek seferde bir işte çalışır. */
const MATCH_LOCK_NAMESPACE = 4242;

export interface CreatedMatch {
  matchId: number;
  userId: string;
  searchProfileId: string;
  reason: MatchEvent;
}

export type MatchOutcome =
  | { status: 'MATCHED'; created: CreatedMatch[]; candidates: number; notifications: PlannedNotification[] }
  | { status: 'SKIPPED'; reason: 'NOT_FOUND' | 'LISTING_INACTIVE'; created: [] };

@Injectable()
export class MatchService {
  private readonly logger = new Logger(MatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async process(data: MatchJobData): Promise<MatchOutcome> {
    const out = await this.prisma.$transaction(
      async (tx): Promise<MatchOutcome> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MATCH_LOCK_NAMESPACE}::int, ${data.listingId}::int)`;
        const analysis = await tx.listingAnalysis.findUnique({ where: { id: data.analysisId }, include: { listing: true } });
        if (!analysis || analysis.listingId !== data.listingId) return { status: 'SKIPPED', reason: 'NOT_FOUND', created: [] } as const;
        const listing = analysis.listing;
        if (listing.status !== 'ACTIVE') return { status: 'SKIPPED', reason: 'LISTING_INACTIVE', created: [] } as const;
        // Eski bir analiz işi yeniden gönderilmiş olabilir: her zaman ilanın en güncel analizi değerlendirilir.
        const latest =
          listing.latestAnalysisId !== null && listing.latestAnalysisId !== analysis.id
            ? await tx.listingAnalysis.findUnique({ where: { id: listing.latestAnalysisId } })
            : null;
        const effective = latest && latest.listingId === listing.id ? latest : analysis;

        const price = effective.listingPrice ?? listing.price;
        const facts: ListingFacts = {
          make: listing.make,
          model: listing.model,
          year: listing.year,
          km: listing.km,
          price,
          fuel: listing.fuel,
          transmission: listing.transmission,
          city: listing.city,
          damaged: effective.flags.includes('DAMAGED'),
          confidence: effective.confidence,
          discountPct: effective.discountPct === null ? null : Number(effective.discountPct),
        };
        const candidates = await findMatchingProfiles(tx, facts, listing.id);
        const created: CreatedMatch[] = [];
        const planned: PlannedMatch[] = [];
        for (const c of candidates) {
          const reason = decideMatchReason(
            data.event,
            { notifyOnPriceDrop: c.notifyOnPriceDrop, priceDropPct: Number(c.priceDropPct), notifyOnRelist: c.notifyOnRelist },
            c.lastMatchedPrice,
            price,
          );
          if (!reason) continue;
          const rows = await tx.$queryRaw<{ id: number }[]>`
            INSERT INTO "ListingMatch" ("userId", "searchProfileId", "listingId", "analysisId", "reason", "matchedPrice")
            VALUES (${c.userId}, ${c.id}, ${listing.id}::int, ${effective.id}::int, ${reason}::"MatchReason", ${price}::bigint)
            ON CONFLICT ("searchProfileId", "listingId", "reason", "matchedPrice") DO NOTHING
            RETURNING "id"`;
          if (rows[0]) {
            created.push({ matchId: rows[0].id, userId: c.userId, searchProfileId: c.id, reason });
            planned.push({
              matchId: rows[0].id,
              userId: c.userId,
              profile: { id: c.id, name: c.name, channels: c.channels },
              reason,
              previousPrice: reason === 'PRICE_DROP' ? c.lastMatchedPrice : null,
            });
          }
        }
        const notifications = created.length
          ? await planNotifications(tx, { listing, analysis: effective, matches: planned, now: new Date() })
          : [];
        return { status: 'MATCHED', created, candidates: candidates.length, notifications } as const;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (out.status === 'MATCHED' && out.created.length > 0) {
      this.logger.log(`İlan ${data.listingId} (${data.event}): ${out.created.length} eşleşme`);
    }
    if (out.status === 'MATCHED') {
      const pending = out.notifications.filter((n) => n.status === 'PENDING');
      if (pending.length > 0) {
        try {
          await this.dispatcher.enqueue(pending);
        } catch (err) {
          // Satırlar commit edildi; NotificationSweepService queuedAt=null olanları yeniden ekler.
          this.logger.warn(`Bildirimler kuyruğa alınamadı (süpürme telafi eder): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return out;
  }
}
