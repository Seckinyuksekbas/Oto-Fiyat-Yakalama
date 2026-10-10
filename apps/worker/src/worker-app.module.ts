import { Module } from '@nestjs/common';
import { CollectionModule } from './collection/collection.module';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';
import { ScrapeWorkerHost } from './processors/scrape-worker.host';

@Module({ imports: [CoreModule, CollectionModule], providers: [HeartbeatService, ScrapeWorkerHost] })
export class WorkerAppModule {}
