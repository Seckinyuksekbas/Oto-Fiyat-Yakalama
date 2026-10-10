import { Module } from '@nestjs/common';
import { NotificationDispatcher } from './notification-dispatcher';

@Module({ providers: [NotificationDispatcher], exports: [NotificationDispatcher] })
export class NotificationsModule {}
