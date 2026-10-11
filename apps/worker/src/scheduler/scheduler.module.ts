import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalysisSweepService } from './analysis-sweep.service';
import { MonitorService } from './monitor.service';
import { NotificationSweepService } from './notification-sweep.service';
import { SubscriptionSweepService } from './subscription-sweep.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [AnalysisModule, NotificationsModule],
  providers: [SchedulerService, AnalysisSweepService, NotificationSweepService, SubscriptionSweepService, MonitorService],
  exports: [SchedulerService, AnalysisSweepService, NotificationSweepService, SubscriptionSweepService, MonitorService],
})
export class SchedulerModule {}
