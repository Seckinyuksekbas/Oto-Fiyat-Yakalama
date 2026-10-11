import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { adminPlanCreateSchema, adminPlanUpdateSchema, checkPlanMaxima, type AdminPlanCreate, type AdminPlanUpdate } from '@oto/shared';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminPlansService } from './plans.service';

const planCreateBody = adminPlanCreateSchema.superRefine(checkPlanMaxima);
const planUpdateBody = adminPlanUpdateSchema.superRefine(checkPlanMaxima);

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plans: AdminPlansService) {}

  @Get()
  list() {
    return this.plans.list();
  }

  @Roles('SUPER_ADMIN')
  @Post()
  @Audited('plan.create')
  create(@AuditCtx() ctx: AuditCtx, @Body(new ZodPipe(planCreateBody)) body: AdminPlanCreate) {
    return this.plans.create(ctx, body);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id')
  @Audited('plan.update')
  update(@AuditCtx() ctx: AuditCtx, @Param('id') id: string, @Body(new ZodPipe(planUpdateBody)) body: AdminPlanUpdate) {
    return this.plans.update(ctx, id, body);
  }
}
