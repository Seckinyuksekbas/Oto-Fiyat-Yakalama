import { Module } from '@nestjs/common';
import { TelegramClient } from '@oto/telegram';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { InAppAdapter } from './in-app.adapter';
import { NotifyService } from './notify.service';
import { TELEGRAM_CLIENT, TelegramAdapter } from './telegram.adapter';
import { TelegramStartupCheck } from './telegram-startup-check';

@Module({
  providers: [
    InAppAdapter,
    TelegramAdapter,
    NotifyService,
    TelegramStartupCheck,
    {
      provide: TELEGRAM_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) => (env.TELEGRAM_BOT_TOKEN ? new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: env.TELEGRAM_API_BASE }) : null),
    },
  ],
  // NotificationDispatcher CoreModule'de (global) sağlanır.
  exports: [NotifyService],
})
export class NotificationsModule {}
