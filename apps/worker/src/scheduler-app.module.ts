import { Module } from '@nestjs/common';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';

@Module({ imports: [CoreModule], providers: [HeartbeatService] })
export class SchedulerAppModule {}
