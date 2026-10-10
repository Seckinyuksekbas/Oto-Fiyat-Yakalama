import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { AnalysisSweepService } from './analysis-sweep.service';
import { SchedulerService } from './scheduler.service';

@Module({ imports: [AnalysisModule], providers: [SchedulerService, AnalysisSweepService], exports: [SchedulerService, AnalysisSweepService] })
export class SchedulerModule {}
