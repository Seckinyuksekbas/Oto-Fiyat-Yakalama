import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalysisSweepService } from './analysis-sweep.service';
import { MonitorService } from './monitor.service';
import { NotificationSweepService } from './notification-sweep.service';
import { RetentionService } from './retention.service';
import { SubscriptionSweepService } from './subscription-sweep.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [AnalysisModule, NotificationsModule],
  providers: [SchedulerService, AnalysisSweepService, NotificationSweepService, SubscriptionSweepService, MonitorService, RetentionService],
  exports: [SchedulerService, AnalysisSweepService, NotificationSweepService, SubscriptionSweepService, MonitorService, RetentionService],
})
export class SchedulerModule {}
