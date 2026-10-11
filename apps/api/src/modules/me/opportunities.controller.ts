import { Controller, Get, Query } from '@nestjs/common';
import { decodeCursor, encodeCursor, opportunitiesQuerySchema, type OpportunitiesQuery } from '@oto/shared';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user';
import { Errors } from '../../common/errors/app-error';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { toListingCard } from './listing-card.view';
import { LimitsService } from './limits.service';
import { OpportunitiesRepository } from './opportunities.repository';

const id = z.number().int().min(1).max(2147483647);
// Sıralamaya göre ayrı şema: başka sıralamanın imleci reddedilir
const cursorSchemas = {
  score: z.object({ s: z.literal('score'), k: z.number().int().min(0).max(100), id }).strict(),
  recent: z.object({ s: z.literal('recent'), k: z.string().datetime(), id }).strict(),
  discount: z.object({ s: z.literal('discount'), k: z.string().regex(/^-?\d{1,4}(\.\d{1,4})?$/), id }).strict(),
};

@Controller('me/opportunities')
export class OpportunitiesController {
  constructor(
    private readonly repo: OpportunitiesRepository,
    private readonly limits: LimitsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(opportunitiesQuerySchema)) q: OpportunitiesQuery) {
    let after: { k: number | string; id: number } | undefined;
    if (q.cursor) {
      const c = decodeCursor(q.cursor, cursorSchemas[q.sort] as z.ZodType<{ k: number | string; id: number }>);
      if (!c) throw Errors.validation([{ path: 'cursor', message: 'Geçersiz imleç' }]);
      after = { k: c.k, id: c.id };
    }
    const { limits } = await this.limits.forUser(user.id);
    const visibleBefore = new Date(Date.now() - limits.opportunitiesDelayHours * 3_600_000);
    const page = await this.repo.list(user.id, {
      make: q.make,
      model: q.model,
      city: q.city,
      maxPrice: q.maxPrice,
      minScore: q.minScore ?? 60,
      confidence: q.confidence ?? 'MEDIUM',
      sort: q.sort,
      after,
      limit: q.limit,
      visibleBefore,
    });
    return {
      items: page.items.map((r) => toListingCard(r.listing, r.analysis, r.isFavorite)),
      nextCursor: page.nextKey ? encodeCursor({ s: q.sort, k: page.nextKey.k, id: page.nextKey.id }) : null,
    };
  }
}
