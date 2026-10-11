import { Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { AuthModule } from '../auth/auth.module';
import { ALLOW_PRIVATE_URLS } from './admin.tokens';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminListingsController } from './listings.controller';
import { AdminListingsService } from './listings.service';
import { AdminJobsController } from './jobs.controller';
import { AdminJobsService } from './jobs.service';
import { AdminProxiesController } from './proxies.controller';
import { AdminProxiesService } from './proxies.service';
import { AdminSourcesController } from './sources.controller';
import { AdminSourcesService } from './sources.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AdminListingsController, AdminSourcesController, AdminJobsController, AdminProxiesController],
  providers: [
    AdminUsersService,
    AdminListingsService,
    AdminSourcesService,
    AdminJobsService,
    AdminProxiesService,
    { provide: ALLOW_PRIVATE_URLS, inject: [ENV], useFactory: (env: Env) => env.NODE_ENV !== 'production' },
  ],
})
export class AdminModule {}
