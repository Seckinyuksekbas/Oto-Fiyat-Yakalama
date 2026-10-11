import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { adminStuckDispatchesQuerySchema, type AdminStuckDispatchesQuery } from '@oto/shared';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminMatchDispatchesService } from './match-dispatches.service';

const idParam = new ZodPipe(z.coerce.number().int().min(1).max(2_147_483_647));

/** `match-dispatch-stuck` alarmının kurtarma uçları (Sistem İzleme sayfası). */
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/match-dispatches')
export class AdminMatchDispatchesController {
  constructor(private readonly dispatches: AdminMatchDispatchesService) {}

  @Get('stuck')
  stuck(@Query(new ZodPipe(adminStuckDispatchesQuerySchema)) q: AdminStuckDispatchesQuery) {
    return this.dispatches.stuck(q);
  }

  @Post(':analysisId/reset')
  @HttpCode(200)
  @Audited('match-dispatch.reset')
  reset(@AuditCtx() ctx: AuditCtx, @Param('analysisId', idParam) analysisId: number) {
    return this.dispatches.reset(ctx, analysisId);
  }
}
