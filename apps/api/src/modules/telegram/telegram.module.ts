import { Module } from '@nestjs/common';
import { TelegramClient } from '@oto/telegram';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { TELEGRAM_API, TELEGRAM_POLLING_AUTOSTART } from './telegram.config';
import { TelegramPollingService } from './telegram-polling.service';
import { TelegramUpdateHandler } from './telegram-update.handler';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  controllers: [TelegramWebhookController],
  providers: [
    {
      provide: TELEGRAM_API,
      inject: [ENV],
      useFactory: (env: Env): TelegramClient | null =>
        env.TELEGRAM_BOT_TOKEN ? new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: env.TELEGRAM_API_BASE }) : null,
    },
    { provide: TELEGRAM_POLLING_AUTOSTART, useValue: process.env.NODE_ENV !== 'test' },
    TelegramUpdateHandler,
    TelegramPollingService,
  ],
  exports: [TELEGRAM_API, TelegramUpdateHandler],
})
export class TelegramModule {}
