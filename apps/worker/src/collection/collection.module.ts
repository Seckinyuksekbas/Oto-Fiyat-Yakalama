import { Module } from '@nestjs/common';
import { AliasService } from './alias.service';
import { IngestService } from './ingest.service';
import { ScrapeRunner } from './scrape-runner.service';
import { SourceHealthService } from './source-health.service';

@Module({
  providers: [AliasService, IngestService, SourceHealthService, ScrapeRunner],
  exports: [AliasService, IngestService, SourceHealthService, ScrapeRunner],
})
export class CollectionModule {}
