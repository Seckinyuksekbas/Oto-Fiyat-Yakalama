import { Module } from '@nestjs/common';
import { AnalysisModule } from './analysis/analysis.module';
import { CollectionModule } from './collection/collection.module';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';
import { MatchingModule } from './matching/matching.module';
import { AnalyzeWorkerHost } from './processors/analyze-worker.host';
import { MatchWorkerHost } from './processors/match-worker.host';
import { ScrapeWorkerHost } from './processors/scrape-worker.host';

@Module({
  imports: [CoreModule, CollectionModule, AnalysisModule, MatchingModule],
  providers: [HeartbeatService, ScrapeWorkerHost, AnalyzeWorkerHost, MatchWorkerHost],
})
export class WorkerAppModule {}
