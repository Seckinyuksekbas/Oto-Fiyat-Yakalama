import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminLogsService, auditLogsQuery, systemLogsQuery, type AuditLogsQuery, type SystemLogsQuery } from './logs.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminLogsController {
  constructor(private readonly logs: AdminLogsService) {}

  @Get('audit-logs')
  auditLogs(@Query(new ZodPipe(auditLogsQuery)) q: AuditLogsQuery) {
    return this.logs.auditLogs(q);
  }

  @Get('system-logs')
  systemLogs(@Query(new ZodPipe(systemLogsQuery)) q: SystemLogsQuery) {
    return this.logs.systemLogs(q);
  }
}
