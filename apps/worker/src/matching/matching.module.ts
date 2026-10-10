import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { MatchService } from './match.service';

@Module({ imports: [NotificationsModule], providers: [MatchService], exports: [MatchService] })
export class MatchingModule {}
