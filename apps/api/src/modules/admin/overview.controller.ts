import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles';
import { AdminOverviewService, type AdminOverview } from './overview.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get('overview')
  get(): Promise<AdminOverview> {
    return this.overview.overview();
  }
}
