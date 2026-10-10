import { Module } from '@nestjs/common';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';
import { SchedulerLoop } from './scheduler/scheduler-loop.service';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({ imports: [CoreModule, SchedulerModule], providers: [HeartbeatService, SchedulerLoop] })
export class SchedulerAppModule {}
