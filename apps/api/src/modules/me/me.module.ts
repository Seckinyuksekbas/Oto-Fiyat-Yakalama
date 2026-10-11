import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ChannelsController } from './channels.controller';
import { ChannelsRepository } from './channels.repository';
import { ChannelsService } from './channels.service';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { FavoritesController } from './favorites.controller';
import { FavoritesRepository } from './favorites.repository';
import { SubscriptionController } from './subscription.controller';
import { LimitsService } from './limits.service';
import { ListingsController } from './listings.controller';
import { ListingsRepository } from './listings.repository';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesRepository } from './opportunities.repository';
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
  controllers: [MeController, SearchProfilesController, MatchesController, NotificationsController, ChannelsController, OpportunitiesController, ListingsController, FavoritesController, DashboardController, SubscriptionController],
  providers: [OpportunitiesRepository, ListingsRepository, FavoritesRepository, DashboardRepository, ChannelsRepository, ChannelsService, MatchesRepository, NotificationsRepository, MeRepository, MeService, LimitsService, SearchProfilesRepository, SearchProfilesService],
})
export class MeModule {}
