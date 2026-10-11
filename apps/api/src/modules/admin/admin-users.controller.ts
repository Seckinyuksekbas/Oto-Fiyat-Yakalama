import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  adminPageQuery,
  adminRoleSchema,
  adminSubscriptionSchema,
  adminUpdateUserSchema,
  adminUsersQuerySchema,
  type AdminRole,
  type AdminSubscription,
  type AdminUpdateUser,
  type AdminUsersQuery,
} from '@oto/shared';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentUser } from '../../common/decorators/current-user';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { AdminUsersService } from './admin-users.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query(new ZodPipe(adminUsersQuerySchema)) q: AdminUsersQuery) {
    return this.users.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Patch(':id')
  @Audited('user.update')
  update(
    @CurrentUser() actor: AuthUser,
    @AuditCtx() ctx: AuditCtx,
    @Param('id') id: string,
    @Body(new ZodPipe(adminUpdateUserSchema)) body: AdminUpdateUser,
  ) {
    return this.users.updateName(actor, ctx, id, body.name);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @Audited('user.suspend')
  suspend(@CurrentUser() actor: AuthUser, @AuditCtx() ctx: AuditCtx, @Param('id') id: string) {
    return this.users.suspend(actor, ctx, id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Audited('user.activate')
  activate(@CurrentUser() actor: AuthUser, @AuditCtx() ctx: AuditCtx, @Param('id') id: string) {
    return this.users.activate(actor, ctx, id);
  }

  @Roles('SUPER_ADMIN')
  @Delete(':id')
  @Audited('user.delete')
  remove(@CurrentUser() actor: AuthUser, @AuditCtx() ctx: AuditCtx, @Param('id') id: string) {
    return this.users.remove(actor, ctx, id);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id/role')
  @Audited('user.role')
  role(
    @CurrentUser() actor: AuthUser,
    @AuditCtx() ctx: AuditCtx,
    @Param('id') id: string,
    @Body(new ZodPipe(adminRoleSchema)) body: AdminRole,
  ) {
    return this.users.changeRole(actor, ctx, id, body.role);
  }

  @Get(':id/search-profiles')
  searchProfiles(@Param('id') id: string) {
    return this.users.searchProfiles(id);
  }

  @Get(':id/notifications')
  notifications(@Param('id') id: string, @Query(new ZodPipe(adminPageQuery)) q: { page: number; pageSize: number }) {
    return this.users.notifications(id, q.page, q.pageSize);
  }

  @Get(':id/usage')
  usage(@Param('id') id: string) {
    return this.users.usage(id);
  }

  @Patch(':id/subscription')
  @Audited('user.subscription')
  subscription(
    @CurrentUser() actor: AuthUser,
    @AuditCtx() ctx: AuditCtx,
    @Param('id') id: string,
    @Body(new ZodPipe(adminSubscriptionSchema)) body: AdminSubscription,
  ) {
    return this.users.changeSubscription(actor, ctx, id, body);
  }
}
