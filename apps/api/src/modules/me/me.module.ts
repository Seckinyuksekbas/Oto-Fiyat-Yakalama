import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ChannelsController } from './channels.controller';
import { ChannelsRepository } from './channels.repository';
import { ChannelsService } from './channels.service';
import { LimitsService } from './limits.service';
import { MatchesController } from './matches.controller';
import { MatchesRepository } from './matches.repository';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { MeController } from './me.controller';
import { MeRepository } from './me.repository';
import { MeService } from './me.service';
import { SearchProfilesController } from './search-profiles.controller';
import { SearchProfilesRepository } from './search-profiles.repository';
import { SearchProfilesService } from './search-profiles.service';

@Module({
  imports: [AuthModule, TelegramModule],
  controllers: [MeController, SearchProfilesController, MatchesController, NotificationsController, ChannelsController],
  providers: [ChannelsRepository, ChannelsService, MatchesRepository, NotificationsRepository, MeRepository, MeService, LimitsService, SearchProfilesRepository, SearchProfilesService],
})
export class MeModule {}
