import { createHash, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { TelegramUpdate } from '@oto/telegram';
import { Public } from '../../common/decorators/public';
import { SkipCsrf } from '../../common/decorators/skip-csrf';
import { Errors } from '../../common/errors/app-error';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { TelegramUpdateHandler } from './telegram-update.handler';

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

@Public()
@SkipCsrf()
@SkipThrottle()
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly handler: TelegramUpdateHandler,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() body: unknown) {
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (this.env.TELEGRAM_MODE !== 'webhook' || !this.env.TELEGRAM_BOT_TOKEN || !expected || !secret || !safeEqual(secret, expected)) {
      throw Errors.unauthenticated();
    }
    if (body && typeof body === 'object' && typeof (body as { update_id?: unknown }).update_id === 'number') {
      const update = body as TelegramUpdate;
      try {
        await this.handler.handle(update);
      } catch (err) {
        // Hata yutulmaz: AllExceptionsFilter 500 döner, Telegram güncellemeyi yeniden dener.
        this.logger.error(`Telegram güncellemesi işlenemedi (update_id=${update.update_id}): ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    return { ok: true };
  }
}
