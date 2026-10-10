import { Module } from '@nestjs/common';
import { AnalysisSettingsService } from './analysis-settings.service';
import { AnalysisService } from './analysis.service';
import { MatchDispatcher } from './match-dispatcher.service';

@Module({
  providers: [AnalysisSettingsService, MatchDispatcher, AnalysisService],
  exports: [AnalysisSettingsService, MatchDispatcher, AnalysisService],
})
export class AnalysisModule {}
