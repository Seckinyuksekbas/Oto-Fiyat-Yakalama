import { Module } from '@nestjs/common';
import { TelegramClient } from '@oto/telegram';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { InAppAdapter } from './in-app.adapter';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotifyService } from './notify.service';
import { TELEGRAM_CLIENT, TelegramAdapter } from './telegram.adapter';

@Module({
  providers: [
    NotificationDispatcher,
    InAppAdapter,
    TelegramAdapter,
    NotifyService,
    {
      provide: TELEGRAM_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) => (env.TELEGRAM_BOT_TOKEN ? new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: env.TELEGRAM_API_BASE }) : null),
    },
  ],
  exports: [NotificationDispatcher, NotifyService],
})
export class NotificationsModule {}
