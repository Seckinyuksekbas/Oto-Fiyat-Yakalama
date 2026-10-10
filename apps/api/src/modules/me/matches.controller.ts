import { Controller, Get, Query } from '@nestjs/common';
import { listMatchesQuerySchema, type ListMatchesQuery } from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { MatchesRepository } from './matches.repository';

@Controller('me/matches')
export class MatchesController {
  constructor(private readonly matches: MatchesRepository) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listMatchesQuerySchema)) q: ListMatchesQuery) {
    const rows = await this.matches.list(user.id, q);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((m) => ({
        id: m.id,
        reason: m.reason,
        matchedPrice: m.matchedPrice.toString(),
        createdAt: m.createdAt,
        profile: m.searchProfile,
        listing: { ...m.listing, price: m.listing.price.toString() },
        analysis: {
          opportunityScore: m.analysis.opportunityScore,
          confidence: m.analysis.confidence,
          discountPct: m.analysis.discountPct === null ? null : Number(m.analysis.discountPct),
          estimatedPrice: m.analysis.estimatedPrice?.toString() ?? null,
        },
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  }
}
