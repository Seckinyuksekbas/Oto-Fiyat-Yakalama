import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import {
  adminSourceCreateSchema,
  adminSourceUpdateSchema,
  adminTestScrapeSchema,
  type AdminSourceCreate,
  type AdminSourceUpdate,
  type AdminTestScrape,
} from '@oto/shared';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminSourcesService, type StatsRange } from './sources.service';

const statsQuery = z.object({ range: z.enum(['24h', '7d', '30d']).default('24h') }).strict();

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/sources')
export class AdminSourcesController {
  constructor(private readonly sources: AdminSourcesService) {}

  @Get()
  list() {
    return this.sources.list();
  }

  @Post()
  @Audited('source.create')
  create(@AuditCtx() ctx: AuditCtx, @Body(new ZodPipe(adminSourceCreateSchema)) body: AdminSourceCreate) {
    return this.sources.create(ctx, body);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.sources.get(id);
  }

  @Patch(':id')
  @Audited('source.update')
  update(@AuditCtx() ctx: AuditCtx, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(adminSourceUpdateSchema)) body: AdminSourceUpdate) {
    return this.sources.update(ctx, id, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Audited('source.activate')
  activate(@AuditCtx() ctx: AuditCtx, @Param('id', ParseIntPipe) id: number) {
    return this.sources.activate(ctx, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Audited('source.pause')
  pause(@AuditCtx() ctx: AuditCtx, @Param('id', ParseIntPipe) id: number) {
    return this.sources.pause(ctx, id);
  }

  @Post(':id/test-scrape')
  @HttpCode(202)
  @Audited('source.test-scrape')
  testScrape(@AuditCtx() ctx: AuditCtx, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(adminTestScrapeSchema)) body: AdminTestScrape) {
    return this.sources.testScrape(ctx, id, body.dryRun);
  }

  @Get(':id/stats')
  stats(@Param('id', ParseIntPipe) id: number, @Query(new ZodPipe(statsQuery)) q: { range: StatsRange }) {
    return this.sources.stats(id, q.range);
  }
}
