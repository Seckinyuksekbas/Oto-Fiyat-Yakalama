import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { adminJobsQuerySchema, type AdminJobsQuery } from '@oto/shared';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminJobsService } from './jobs.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @Get()
  list(@Query(new ZodPipe(adminJobsQuerySchema)) q: AdminJobsQuery) {
    return this.jobs.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.jobs.get(id);
  }
}
