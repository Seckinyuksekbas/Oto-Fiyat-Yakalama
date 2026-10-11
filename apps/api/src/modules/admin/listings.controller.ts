import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  adminAnalysesQuerySchema,
  adminListingIssuesQuerySchema,
  adminListingsQuerySchema,
  type AdminAnalysesQuery,
  type AdminListingIssuesQuery,
  type AdminListingsQuery,
} from '@oto/shared';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminListingsService } from './listings.service';

const idParam = new ZodPipe(z.coerce.number().int().min(1).max(2_147_483_647));

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminListingsController {
  constructor(private readonly listings: AdminListingsService) {}

  @Get('listings')
  list(@Query(new ZodPipe(adminListingsQuerySchema)) q: AdminListingsQuery) {
    return this.listings.list(q);
  }

  @Get('listings/:id')
  get(@Param('id', idParam) id: number) {
    return this.listings.get(id);
  }

  /** Eşzamansız iş: 200 değil 202 (kuyruğa alındı). */
  @Post('listings/:id/reanalyze')
  @HttpCode(202)
  @Audited('listing.reanalyze')
  reanalyze(@AuditCtx() ctx: AuditCtx, @Param('id', idParam) id: number) {
    return this.listings.reanalyze(ctx, id);
  }

  @Get('listing-issues')
  issues(@Query(new ZodPipe(adminListingIssuesQuerySchema)) q: AdminListingIssuesQuery) {
    return this.listings.issues(q);
  }

  @Get('analyses')
  analyses(@Query(new ZodPipe(adminAnalysesQuerySchema)) q: AdminAnalysesQuery) {
    return this.listings.analyses(q);
  }

  @Get('analyses/:id')
  analysis(@Param('id', idParam) id: number) {
    return this.listings.analysis(id);
  }
}
