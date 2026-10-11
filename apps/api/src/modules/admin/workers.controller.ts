import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles';
import { AdminWorkersService } from './workers.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/workers')
export class AdminWorkersController {
  constructor(private readonly workers: AdminWorkersService) {}

  @Get()
  list() {
    return this.workers.list();
  }
}
