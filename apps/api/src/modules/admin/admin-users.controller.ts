import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { adminUsersQuerySchema, type AdminUsersQuery } from '@oto/shared';
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

  @Post(':id/suspend')
  @Audited('user.suspend')
  suspend(@CurrentUser() actor: AuthUser, @AuditCtx() ctx: AuditCtx, @Param('id') id: string) {
    return this.users.suspend(actor, ctx, id);
  }

  @Post(':id/activate')
  @Audited('user.activate')
  activate(@CurrentUser() actor: AuthUser, @AuditCtx() ctx: AuditCtx, @Param('id') id: string) {
    return this.users.activate(actor, ctx, id);
  }
}
