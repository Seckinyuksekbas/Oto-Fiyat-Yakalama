import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';

const MESSAGE = 'TELEGRAM_BOT_TOKEN ayarlı değil: Telegram bildirimleri gönderilmeyecek (TELEGRAM_DISABLED). Bkz. docs/operations/telegram-bot.md';

/**
 * Production worker'ında bot token'ı yoksa açılışta bir kez uyarır ve admin panelinde görünsün diye
 * tek bir `SystemLog` WARN satırı (component `telegram`) yazar. Süreç yine açılır (token isteğe bağlıdır);
 * SystemLog yazılamazsa açılış düşmez. Scheduler Telegram'a hiç bağlanmaz (token'ı yok): denetim yalnız ROLE=worker'da çalışır.
 */
@Injectable()
export class TelegramStartupCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramStartupCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.NODE_ENV !== 'production' || this.env.ROLE !== 'worker' || this.env.TELEGRAM_BOT_TOKEN) return;
    this.logger.warn(MESSAGE);
    try {
      await this.prisma.systemLog.create({ data: { level: 'WARN', component: 'telegram', message: MESSAGE } });
    } catch (err) {
      this.logger.warn(`Telegram uyarısı SystemLog'a yazılamadı: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
