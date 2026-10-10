import { Module } from '@nestjs/common';
import { AliasService } from './alias.service';
import { IngestService } from './ingest.service';

@Module({ providers: [AliasService, IngestService], exports: [AliasService, IngestService] })
export class CollectionModule {}
