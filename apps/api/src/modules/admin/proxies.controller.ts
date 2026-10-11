import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { adminProxyCreateSchema, adminProxyUpdateSchema, type AdminProxyCreate, type AdminProxyUpdate } from '@oto/shared';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminProxiesService } from './proxies.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/proxies')
export class AdminProxiesController {
  constructor(private readonly proxies: AdminProxiesService) {}

  @Get()
  list() {
    return this.proxies.list();
  }

  @Post()
  @Audited('proxy.create')
  create(@AuditCtx() ctx: AuditCtx, @Body(new ZodPipe(adminProxyCreateSchema)) body: AdminProxyCreate) {
    return this.proxies.create(ctx, body);
  }

  @Patch(':id')
  @Audited('proxy.update')
  update(@AuditCtx() ctx: AuditCtx, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(adminProxyUpdateSchema)) body: AdminProxyUpdate) {
    return this.proxies.update(ctx, id, body);
  }

  @Post(':id/check')
  @HttpCode(200)
  @Audited('proxy.check')
  check(@AuditCtx() ctx: AuditCtx, @Param('id', ParseIntPipe) id: number) {
    return this.proxies.check(ctx, id);
  }
}
