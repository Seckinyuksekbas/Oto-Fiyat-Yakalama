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
import { AdminLogsController } from './logs.controller';
import { AdminLogsService } from './logs.service';
import { AdminPlansController } from './plans.controller';
import { AdminPlansService } from './plans.service';
import { AdminSettingsController } from './settings.controller';
import { AdminSettingsService } from './settings.service';
import { AdminQueuesController } from './queues.controller';
import { AdminQueuesService } from './queues.service';
import { AdminWorkersController } from './workers.controller';
import { AdminWorkersService } from './workers.service';
import { AdminNotificationsController } from './notifications.controller';
import { AdminNotificationsService } from './notifications.service';
import { AdminMatchDispatchesController } from './match-dispatches.controller';
import { AdminMatchDispatchesService } from './match-dispatches.service';
import { AdminEventsService } from './admin-events.service';
import { AdminStreamController } from './admin-stream.controller';
import { AdminOverviewController } from './overview.controller';
import { AdminOverviewService } from './overview.service';

@Module({
  imports: [AuthModule],
  controllers: [
    AdminUsersController, AdminListingsController, AdminSourcesController, AdminJobsController, AdminProxiesController,
    AdminPlansController,
    AdminSettingsController,
    AdminLogsController,
    AdminQueuesController,
    AdminWorkersController,
    AdminNotificationsController,
    AdminMatchDispatchesController,
    AdminOverviewController,
    AdminStreamController,
  ],
  providers: [
    AdminUsersService,
    AdminListingsService,
    AdminSourcesService,
    AdminJobsService,
    AdminProxiesService,
    AdminPlansService,
    AdminSettingsService,
    AdminLogsService,
    AdminQueuesService,
    AdminWorkersService,
    AdminNotificationsService,
    AdminMatchDispatchesService,
    AdminOverviewService,
    AdminEventsService,
    { provide: ALLOW_PRIVATE_URLS, inject: [ENV], useFactory: (env: Env) => env.NODE_ENV !== 'production' },
  ],
})
export class AdminModule {}
