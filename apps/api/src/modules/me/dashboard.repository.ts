import { Injectable } from '@nestjs/common';
import type { Listing, ListingAnalysis, ListingMatch } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

export type RecentMatchRow = ListingMatch & {
  searchProfile: { id: string; name: string };
  listing: Listing & { latestAnalysis: ListingAnalysis | null; favorites: { userId: string }[] };
};

@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  recentMatches(userId: string, take: number): Promise<RecentMatchRow[]> {
    return this.prisma.listingMatch.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      include: {
        searchProfile: { select: { id: true, name: true } },
        listing: { include: { latestAnalysis: true, favorites: { where: { userId }, select: { userId: true } } } },
      },
    });
  }

  async profileCounts(userId: string): Promise<{ active: number; total: number }> {
    const [active, total] = await Promise.all([
      this.prisma.searchProfile.count({ where: { userId, status: 'ACTIVE' } }),
      this.prisma.searchProfile.count({ where: { userId } }),
    ]);
    return { active, total };
  }

  /** İstanbul gününe göre günlük eşleşme sayısı (yalnızca eşleşme olan günler). */
  matchesPerDay(userId: string, since: Date): Promise<{ day: string; matches: number }[]> {
    return this.prisma.$queryRaw<{ day: string; matches: number }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'Europe/Istanbul')::date, 'YYYY-MM-DD') AS day, count(*)::int AS matches
      FROM "ListingMatch" WHERE "userId" = ${userId} AND "createdAt" >= ${since}
      GROUP BY 1`;
  }
}
