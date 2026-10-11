import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { adminPlanCreateSchema, adminPlanUpdateSchema, type AdminPlanCreate, type AdminPlanUpdate, type PlanLimits } from '@oto/shared';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminPlansService } from './plans.service';

/** Makul üst sınırlar: yanlış girişin (ör. fazladan sıfır) limit sistemini fiilen kapatmasını önler. */
export const PLAN_MAXIMA = {
  priceMonthly: 10_000_000,
  maxSearchProfiles: 1000,
  maxNotificationsPerDay: 100_000,
  opportunitiesDelayHours: 720,
} as const;

function checkPlan(p: { priceMonthly?: number; limits?: PlanLimits }, ctx: z.RefinementCtx): void {
  if (p.priceMonthly !== undefined) {
    if (!Number.isInteger(p.priceMonthly)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMonthly'], message: 'Fiyat tam sayı olmalı' });
    if (p.priceMonthly > PLAN_MAXIMA.priceMonthly) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMonthly'], message: `En fazla ${PLAN_MAXIMA.priceMonthly}` });
  }
  const l = p.limits;
  if (!l) return;
  for (const k of ['maxSearchProfiles', 'maxNotificationsPerDay', 'opportunitiesDelayHours'] as const) {
    if (l[k] > PLAN_MAXIMA[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['limits', k], message: `En fazla ${PLAN_MAXIMA[k]}` });
  }
  if (new Set(l.channels).size !== l.channels.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['limits', 'channels'], message: 'Kanallar tekrarlanamaz' });
}

const planCreateBody = adminPlanCreateSchema.superRefine(checkPlan);
const planUpdateBody = adminPlanUpdateSchema.superRefine(checkPlan);

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
