import { Injectable } from '@nestjs/common';
import type { Listing, ListingAnalysis, ListingMatch, ListingPriceHistory, ListingStatus } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

export interface ComparableListing {
  id: number;
  title: string;
  city: string | null;
  url: string;
  status: ListingStatus;
}

export interface ListingDetailRow {
  listing: Listing;
  analysis: ListingAnalysis | null;
  isFavorite: boolean;
  priceHistory: ListingPriceHistory[];
  myMatches: Array<ListingMatch & { searchProfile: { id: string; name: string } }>;
}

/** İlan detayına erişim; favori ve eşleşmeler yalnızca userId ile okunur. */
@Injectable()
export class ListingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findDetail(userId: string, id: number): Promise<ListingDetailRow | null> {
    const l = await this.prisma.listing.findUnique({
      where: { id },
      include: {
        latestAnalysis: true,
        // En yeni 200 kayıt alınır, sonra artan sıraya çevrilir
        priceHistory: { orderBy: { observedAt: 'desc' }, take: 200 },
        favorites: { where: { userId }, select: { userId: true } },
        matches: {
          where: { userId },
          orderBy: { id: 'desc' },
          take: 20,
          include: { searchProfile: { select: { id: true, name: true } } },
        },
      },
    });
    if (!l) return null;
    const { latestAnalysis, priceHistory, favorites, matches, ...listing } = l;
    return {
      listing,
      analysis: latestAnalysis,
      isFavorite: favorites.length > 0,
      priceHistory: [...priceHistory].reverse(),
      myMatches: matches,
    };
  }

  /** Emsal ilanların başlık/şehir/url bilgisi (merkezi veri). */
  findComparableListings(ids: number[]): Promise<ComparableListing[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.listing.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, city: true, url: true, status: true },
    });
  }
}
