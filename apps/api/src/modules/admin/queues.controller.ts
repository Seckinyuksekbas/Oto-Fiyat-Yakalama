import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { adminQueueCleanSchema, adminQueueNameSchema, type AdminQueueClean, type AdminQueueName } from '@oto/shared';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminQueuesService } from './queues.service';

/** Kuyruk adı beyaz listeden (scrape, analyze, match, notify, notify-telegram); bilinmeyen ad 400. */
const queueParam = new ZodPipe(adminQueueNameSchema);

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/queues')
export class AdminQueuesController {
  constructor(private readonly queues: AdminQueuesService) {}

  @Get()
  list() {
    return this.queues.list();
  }

  @Post(':name/retry-failed')
  @HttpCode(200)
  @Audited('queue.retry-failed')
  retryFailed(@AuditCtx() ctx: AuditCtx, @Param('name', queueParam) name: AdminQueueName) {
    return this.queues.retryFailed(ctx, name);
  }

  @Post(':name/clean')
  @HttpCode(200)
  @Audited('queue.clean')
  clean(
    @AuditCtx() ctx: AuditCtx,
    @Param('name', queueParam) name: AdminQueueName,
    @Body(new ZodPipe(adminQueueCleanSchema)) body: AdminQueueClean,
  ) {
    return this.queues.clean(ctx, name, body);
  }
}
