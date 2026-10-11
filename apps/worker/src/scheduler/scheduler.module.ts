import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalysisSweepService } from './analysis-sweep.service';
import { NotificationSweepService } from './notification-sweep.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [AnalysisModule, NotificationsModule],
  providers: [SchedulerService, AnalysisSweepService, NotificationSweepService],
  exports: [SchedulerService, AnalysisSweepService, NotificationSweepService],
})
export class SchedulerModule {}
