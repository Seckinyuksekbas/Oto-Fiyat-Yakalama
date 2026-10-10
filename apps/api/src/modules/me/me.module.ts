import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LimitsService } from './limits.service';
import { MeController } from './me.controller';
import { MeRepository } from './me.repository';
import { MeService } from './me.service';
import { SearchProfilesController } from './search-profiles.controller';
import { SearchProfilesRepository } from './search-profiles.repository';
import { SearchProfilesService } from './search-profiles.service';

@Module({
  imports: [AuthModule],
  controllers: [MeController, SearchProfilesController],
  providers: [MeRepository, MeService, LimitsService, SearchProfilesRepository, SearchProfilesService],
})
export class MeModule {}
