import { Injectable } from '@nestjs/common';
import type { Confidence, ListingStatus, MatchReason, Prisma } from '@oto/db';
import { confidenceAtLeast, type ListMatchesQuery } from '@oto/shared';
import { PrismaService } from '../../infra/prisma.service';

export interface MatchRow {
  id: number;
  reason: MatchReason;
  matchedPrice: bigint;
  createdAt: Date;
  searchProfile: { id: string; name: string };
  listing: {
    id: number; title: string; make: string; model: string; year: number; km: number; city: string | null;
    price: bigint; imageUrl: string | null; url: string; status: ListingStatus;
  };
  analysis: { opportunityScore: number; confidence: Confidence; discountPct: Prisma.Decimal | null; estimatedPrice: bigint | null };
}

@Injectable()
export class MatchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, q: ListMatchesQuery): Promise<MatchRow[]> {
    return this.prisma.listingMatch.findMany({
      where: {
        userId,
        ...(q.profileId ? { searchProfileId: q.profileId } : {}),
        ...(q.reason ? { reason: q.reason } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        ...(q.minScore !== undefined || q.confidence
          ? {
              analysis: {
                ...(q.minScore !== undefined ? { opportunityScore: { gte: q.minScore } } : {}),
                ...(q.confidence ? { confidence: { in: confidenceAtLeast(q.confidence) } } : {}),
              },
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      include: {
        searchProfile: { select: { id: true, name: true } },
        listing: { select: { id: true, title: true, make: true, model: true, year: true, km: true, city: true, price: true, imageUrl: true, url: true, status: true } },
        analysis: { select: { opportunityScore: true, confidence: true, discountPct: true, estimatedPrice: true } },
      },
    });
  }
}
