import { Injectable } from '@nestjs/common';
import type { Favorite, Listing, ListingAnalysis } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

export type FavoriteRow = Favorite & { listing: Listing & { latestAnalysis: ListingAnalysis | null } };

/** Favoriler: her sorgu userId ile kapsamlanır. */
@Injectable()
export class FavoritesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** En yeni önce; limit + 1 satır döner (sonraki sayfa tespiti için). */
  list(userId: string, opts: { cursor?: number; limit: number }): Promise<FavoriteRow[]> {
    return this.prisma.favorite.findMany({
      where: { userId, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: opts.limit + 1,
      include: { listing: { include: { latestAnalysis: true } } },
    });
  }

  async listingExists(listingId: number): Promise<boolean> {
    const l = await this.prisma.listing.findUnique({ where: { id: listingId }, select: { id: true } });
    return l !== null;
  }

  /** `note` verilmezse mevcut not korunur, null silinir; id/createdAt değişmez. */
  async upsert(userId: string, listingId: number, note: string | null | undefined): Promise<FavoriteRow | null> {
    try {
      return await this.prisma.favorite.upsert({
        where: { userId_listingId: { userId, listingId } },
        create: { userId, listingId, note: note ?? null },
        update: note === undefined ? {} : { note },
        include: { listing: { include: { latestAnalysis: true } } },
      });
    } catch (e) {
      // İlan, varlık kontrolü ile yazma arasında silindi (FK ihlali)
      if ((e as { code?: string }).code === 'P2003') return null;
      throw e;
    }
  }

  async remove(userId: string, listingId: number): Promise<boolean> {
    const res = await this.prisma.favorite.deleteMany({ where: { userId, listingId } });
    return res.count === 1;
  }
}
