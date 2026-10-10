import { Injectable } from '@nestjs/common';
import type { ListingProblem, NormalizedListing } from '@oto/collection';
import { Prisma } from '@oto/db';
import type { AnalyzeJobData, AnalyzeReason } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RETRYING_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export type IngestOutcome = 'NEW' | 'PRICE_CHANGED' | 'UPDATED' | 'RELISTED' | 'UNCHANGED';

export interface IngestResult {
  outcome: IngestOutcome;
  listingId: number;
}

export function analyzeJobId(listingId: number, reason: AnalyzeReason, contentHash: string): string {
  return `analyze-${listingId}-${reason}-${contentHash.slice(0, 16)}`;
}

function listingData(l: NormalizedListing) {
  return {
    url: l.url,
    title: l.title,
    imageUrl: l.imageUrl,
    make: l.make,
    model: l.model,
    trim: l.trim,
    year: l.year,
    km: l.km,
    fuel: l.fuel,
    transmission: l.transmission,
    bodyType: l.bodyType,
    color: l.color,
    city: l.city,
    sellerType: l.sellerType,
    damageInfo: l.damageInfo ? (l.damageInfo as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    price: l.price,
    currency: l.currency,
    contentHash: l.contentHash,
  };
}

const RELIST_TWIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  async ingest(sourceId: number, l: NormalizedListing, seenAt: Date): Promise<IngestResult> {
    const existing = await this.prisma.listing.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: l.externalId } },
    });

    if (!existing) {
      const twin = await this.findRelistTwin(sourceId, l, seenAt);
      if (twin) {
        try {
          await this.prisma.listing.update({ where: { id: twin.id }, data: { externalId: l.externalId } });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        return this.ingest(sourceId, l, seenAt);
      }
      try {
        const created = await this.prisma.listing.create({
          data: {
            sourceId,
            externalId: l.externalId,
            ...listingData(l),
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
            priceHistory: { create: { price: l.price, km: l.km, observedAt: seenAt } },
          },
        });
        await this.enqueueAnalyze(created.id, 'NEW', l.contentHash);
        return { outcome: 'NEW', listingId: created.id };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return this.ingest(sourceId, l, seenAt);
      }
    }

    const relisted = existing.status === 'REMOVED';
    if (!relisted && existing.contentHash === l.contentHash) {
      await this.prisma.listing.update({ where: { id: existing.id }, data: { lastSeenAt: seenAt } });
      return { outcome: 'UNCHANGED', listingId: existing.id };
    }

    const priceChanged = existing.price !== l.price;
    const kmChanged = existing.km !== l.km;
    await this.prisma.$transaction([
      this.prisma.listing.update({
        where: { id: existing.id },
        data: {
          ...listingData(l),
          lastSeenAt: seenAt,
          ...(relisted ? { status: 'ACTIVE' as const, removedAt: null, relistedAt: seenAt } : {}),
        },
      }),
      ...(priceChanged || kmChanged
        ? [this.prisma.listingPriceHistory.create({ data: { listingId: existing.id, price: l.price, km: l.km, observedAt: seenAt } })]
        : []),
    ]);

    const outcome: IngestOutcome = relisted ? 'RELISTED' : priceChanged ? 'PRICE_CHANGED' : 'UPDATED';
    const reason: AnalyzeReason = relisted ? 'RELIST' : priceChanged ? 'PRICE_CHANGE' : 'UPDATE';
    await this.enqueueAnalyze(existing.id, reason, l.contentHash, priceChanged ? existing.price : undefined);
    return { outcome, listingId: existing.id };
  }

  /** Spec §5.1: aynı kaynak + başlık + km + yıl ve son 7 günde kaldırılmış ilan → yeni externalId ile yeniden yayın. */
  private findRelistTwin(sourceId: number, l: NormalizedListing, seenAt: Date) {
    return this.prisma.listing.findFirst({
      where: {
        sourceId,
        status: 'REMOVED',
        year: l.year,
        km: l.km,
        title: l.title,
        removedAt: { gte: new Date(seenAt.getTime() - RELIST_TWIN_WINDOW_MS) },
      },
      orderBy: { removedAt: 'desc' },
      select: { id: true },
    });
  }

  async recordProblems(sourceId: number, problems: ListingProblem[]): Promise<void> {
    if (problems.length === 0) return;
    await this.prisma.listingIssue.createMany({
      data: problems.map((p) => ({
        sourceId,
        externalId: p.externalId?.slice(0, 100) ?? null,
        field: p.field.slice(0, 100),
        problem: p.problem.slice(0, 500),
        rawSnippet: p.rawSnippet?.slice(0, 1000) ?? null,
      })),
    });
  }

  /** Görülen ama geçersiz/ayrıştırılamayan ilanların kaldırılmış sayılmaması için lastSeenAt günceller. */
  async touchSeen(sourceId: number, externalIds: string[], seenAt: Date): Promise<number> {
    if (externalIds.length === 0) return 0;
    const { count } = await this.prisma.listing.updateMany({
      where: { sourceId, status: 'ACTIVE', externalId: { in: externalIds } },
      data: { lastSeenAt: seenAt },
    });
    return count;
  }

  /** Belirtilen andan beri görülmeyen aktif ilanları REMOVED yapar; yalnızca tam ve sağlıklı taramadan sonra çağrılmalıdır. */
  async markRemoved(sourceId: number, notSeenSince: Date): Promise<number> {
    const { count } = await this.prisma.listing.updateMany({
      where: { sourceId, status: 'ACTIVE', lastSeenAt: { lt: notSeenSince } },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    return count;
  }

  /** Belirtilen andan beri görülmeyen aktif ilan sayısı (markRemoved'un kaldıracağı küme). */
  async countRemovalCandidates(sourceId: number, notSeenSince: Date): Promise<number> {
    return this.prisma.listing.count({ where: { sourceId, status: 'ACTIVE', lastSeenAt: { lt: notSeenSince } } });
  }

  async countActive(sourceId: number): Promise<number> {
    return this.prisma.listing.count({ where: { sourceId, status: 'ACTIVE' } });
  }

  /**
   * Tarama sonrası: bu taramada ilk görülen ve henüz yetersiz (INSUFFICIENT) ya da hiç analiz edilmemiş ilanlar
   * için, havuz tamamlandıktan sonra REFRESH analizi kuyruğa alınır. Gerçek zamanlı (varsayılan) öncelik.
   */
  async enqueuePostScrapeAnalysis(sourceId: number, since: Date, collectionJobId: number): Promise<number> {
    let cursor = 0;
    let total = 0;
    for (;;) {
      const rows = await this.prisma.listing.findMany({
        where: {
          sourceId,
          status: 'ACTIVE',
          firstSeenAt: { gte: since },
          id: { gt: cursor },
          OR: [{ latestAnalysisId: null }, { latestAnalysis: { confidence: 'INSUFFICIENT' } }],
        },
        orderBy: { id: 'asc' },
        take: 500,
        select: { id: true },
      });
      if (rows.length === 0) break;
      await this.queues.analyze.addBulk(
        rows.map((r) => ({
          name: 'analyze',
          data: { listingId: r.id, reason: 'REFRESH' as const },
          opts: { jobId: `analyze-post-${r.id}-${collectionJobId}`, ...RETRYING_JOB_OPTS },
        })),
      );
      total += rows.length;
      cursor = rows[rows.length - 1].id;
    }
    return total;
  }

  private async enqueueAnalyze(listingId: number, reason: AnalyzeReason, contentHash: string, previousPrice?: bigint): Promise<void> {
    const data: AnalyzeJobData = { listingId, reason, ...(previousPrice !== undefined ? { previousPrice: previousPrice.toString() } : {}) };
    await this.queues.analyze.add('analyze', data, { jobId: analyzeJobId(listingId, reason, contentHash), ...RETRYING_JOB_OPTS });
  }
}
