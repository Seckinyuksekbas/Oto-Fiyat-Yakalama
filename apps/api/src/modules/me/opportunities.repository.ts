import { Injectable } from '@nestjs/common';
import { Prisma, type Listing, type ListingAnalysis } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

export type OpportunitySort = 'score' | 'recent' | 'discount';

export interface OpportunityFilter {
  make?: string;
  model?: string;
  city?: string;
  maxPrice?: string;
  minScore: number;
  confidence: 'MEDIUM' | 'HIGH';
  sort: OpportunitySort;
  /** Sıralama anahtarı: score → tam sayı, recent → ISO tarih, discount → ondalık dizgi */
  after?: { k: number | string; id: number };
  limit: number;
  visibleBefore: Date;
}

export interface OpportunityRow {
  listing: Listing;
  analysis: ListingAnalysis | null;
  isFavorite: boolean;
  /** Bu satırdan devam etmek için sıralama anahtarı */
  key: number | string;
}

interface KeyRow {
  id: number;
  k: number | string | Date;
}

// Sabit SQL parçaları: kullanıcı girdisi içermez.
const KEY_EXPR: Record<OpportunitySort, Prisma.Sql> = {
  score: Prisma.sql`a."opportunityScore"`,
  recent: Prisma.sql`l."firstSeenAt"`,
  discount: Prisma.sql`COALESCE(a."discountPct", -1)`,
};

/** Fırsat akışına erişim. Yalnızca favori işareti kullanıcıya özeldir ve userId ile kapsamlanır. */
@Injectable()
export class OpportunitiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, f: OpportunityFilter): Promise<OpportunityRow[]> {
    const key = KEY_EXPR[f.sort];
    const conds: Prisma.Sql[] = [
      Prisma.sql`l.status = 'ACTIVE'`,
      Prisma.sql`a."opportunityScore" >= ${f.minScore}`,
      Prisma.sql`confidence_rank(a.confidence::text) >= confidence_rank(${f.confidence}::text)`,
      Prisma.sql`l."firstSeenAt" <= ${f.visibleBefore.toISOString()}::timestamp`,
    ];
    if (f.make) conds.push(Prisma.sql`fold_tr(l.make) = fold_tr(${f.make}::text)`);
    if (f.model) conds.push(Prisma.sql`fold_tr(l.model) = fold_tr(${f.model}::text)`);
    if (f.city) conds.push(Prisma.sql`fold_tr(l.city) = fold_tr(${f.city}::text)`);
    if (f.maxPrice) conds.push(Prisma.sql`l.price <= ${BigInt(f.maxPrice)}`);
    if (f.after) {
      const k = f.after.k;
      const param =
        f.sort === 'score'
          ? Prisma.sql`${Number(k)}::int`
          : f.sort === 'recent'
            ? Prisma.sql`${String(k)}::timestamp`
            : Prisma.sql`${String(k)}::numeric`;
      conds.push(Prisma.sql`(${key}, l.id) < (${param}, ${f.after.id}::int)`);
    }
    const rows = await this.prisma.$queryRaw<KeyRow[]>`
      SELECT l.id AS id, ${key} AS k
      FROM "Listing" l
      JOIN "ListingAnalysis" a ON a.id = l."latestAnalysisId"
      WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY ${key} DESC, l.id DESC
      LIMIT ${f.limit + 1}`;
    if (rows.length === 0) return [];

    const listings = await this.prisma.listing.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      include: { latestAnalysis: true, favorites: { where: { userId }, select: { userId: true } } },
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    return rows.flatMap((r) => {
      const l = byId.get(r.id);
      if (!l) return [];
      const { latestAnalysis, favorites, ...listing } = l;
      const k = r.k instanceof Date ? r.k.toISOString() : r.k;
      return [{ listing, analysis: latestAnalysis, isFavorite: favorites.length > 0, key: f.sort === 'score' ? Number(k) : String(k) }];
    });
  }
}
