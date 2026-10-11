import { Controller, Get, Param } from '@nestjs/common';
import type { ListingDetail } from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { Errors } from '../../common/errors/app-error';
import type { AuthUser } from '../auth/auth-user';
import { roundedMoney, toListingCard } from './listing-card.view';
import { ListingsRepository } from './listings.repository';

interface RawComparable {
  id: number;
  price: number;
  year: number;
  km: number;
  damaged: boolean;
  adjusted: number;
  clamped: boolean;
  outlier: boolean;
}

function parseComparables(explanation: unknown): RawComparable[] {
  const list = (explanation as { comparables?: unknown } | null)?.comparables;
  if (!Array.isArray(list)) return [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return list
    .filter((c): c is RawComparable => {
      if (c === null || typeof c !== 'object') return false;
      const r = c as Record<string, unknown>;
      return (
        Number.isInteger(r.id) && num(r.price) && num(r.year) && num(r.km) && num(r.adjusted) &&
        typeof r.damaged === 'boolean' && typeof r.clamped === 'boolean' && typeof r.outlier === 'boolean'
      );
    })
    .slice(0, 200);
}

@Controller('me/listings')
export class ListingsController {
  constructor(private readonly listings: ListingsRepository) {}

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') rawId: string): Promise<ListingDetail> {
    if (!/^\d{1,10}$/.test(rawId)) throw Errors.notFound();
    const id = Number(rawId);
    if (id < 1 || id > 2147483647) throw Errors.notFound();
    const row = await this.listings.findDetail(user.id, id);
    if (!row) throw Errors.notFound();
    const { listing: l, analysis } = row;

    // Uç değer olmayanlar önce (sıra korunur), en fazla 30
    const raw = parseComparables(analysis?.explanation);
    const ordered = [...raw.filter((c) => !c.outlier), ...raw.filter((c) => c.outlier)];
    const joined = new Map((await this.listings.findComparableListings(ordered.map((c) => c.id))).map((c) => [c.id, c]));
    const comparables = ordered
      .filter((c) => joined.has(c.id))
      .slice(0, 30)
      .flatMap((c) => {
      const j = joined.get(c.id);
      if (!j) return [];
      return [
        {
          id: c.id,
          title: j.title,
          city: j.city,
          url: j.url,
          year: c.year,
          km: c.km,
          price: String(Math.round(c.price)),
          adjusted: roundedMoney(c.adjusted) ?? String(Math.round(c.price)),
          damaged: !!c.damaged,
          outlier: !!c.outlier,
          clamped: !!c.clamped,
          status: j.status,
        },
      ];
    });

    return {
      ...toListingCard(l, analysis, row.isFavorite),
      lastSeenAt: l.lastSeenAt.toISOString(),
      removedAt: l.removedAt?.toISOString() ?? null,
      damageInfo: (l.damageInfo as ListingDetail['damageInfo']) ?? null,
      bodyType: l.bodyType,
      color: l.color,
      sellerType: l.sellerType,
      priceHistory: row.priceHistory.map((p) => ({ price: p.price.toString(), km: p.km, observedAt: p.observedAt.toISOString() })),
      explanation: analysis?.explanation ?? null,
      comparables,
      myMatches: row.myMatches.map((m) => ({
        id: m.id,
        reason: m.reason,
        matchedPrice: m.matchedPrice.toString(),
        createdAt: m.createdAt.toISOString(),
        profile: m.searchProfile,
      })),
    };
  }
}
