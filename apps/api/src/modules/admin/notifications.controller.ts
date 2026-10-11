import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  adminNotificationLatencyQuerySchema,
  adminNotificationRetrySchema,
  adminNotificationsQuerySchema,
  type AdminNotificationLatencyQuery,
  type AdminNotificationRetry,
  type AdminNotificationsQuery,
} from '@oto/shared';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminNotificationsService } from './notifications.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: AdminNotificationsService) {}

  @Get()
  list(@Query(new ZodPipe(adminNotificationsQuerySchema)) q: AdminNotificationsQuery) {
    return this.notifications.list(q);
  }

  @Get('latency')
  latency(@Query(new ZodPipe(adminNotificationLatencyQuerySchema)) q: AdminNotificationLatencyQuery) {
    return this.notifications.latency(q);
  }

  @Post('retry')
  @HttpCode(200)
  @Audited('notification.retry')
  retry(@AuditCtx() ctx: AuditCtx, @Body(new ZodPipe(adminNotificationRetrySchema)) body: AdminNotificationRetry) {
    return this.notifications.retry(ctx, body.ids);
  }
}
