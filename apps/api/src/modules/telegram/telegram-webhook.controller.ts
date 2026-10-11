import { createHash, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { TelegramUpdate } from '@oto/telegram';
import { Public } from '../../common/decorators/public';
import { SkipCsrf } from '../../common/decorators/skip-csrf';
import { Errors } from '../../common/errors/app-error';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { RedisService } from '../../infra/redis.service';
import { HANDLER_MAX_ATTEMPTS } from './telegram-errors';
import { TelegramUpdateHandler } from './telegram-update.handler';

const FAIL_COUNTER_TTL_SEC = 86_400;

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
    private readonly redis: RedisService,
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
      const failKey = `tg:update:fail:${update.update_id}`;
      try {
        await this.handler.handle(update);
      } catch (err) {
        // Hata ayrıntısını AllExceptionsFilter loglar; burada yalnız kimlik.
        this.logger.warn(`Telegram güncellemesi işlenemedi (update_id=${update.update_id})`);
        // Redis de çalışmıyorsa sayılamaz: hata yukarı gider (500) ve Telegram yeniden dener.
        const counted = await this.redis.multi().incr(failKey).expire(failKey, FAIL_COUNTER_TTL_SEC).exec();
        const [incrErr, attempts] = counted?.[0] ?? [new Error('sayaç işlemi iptal edildi'), null];
        if (incrErr) throw err;
        if (Number(attempts) >= HANDLER_MAX_ATTEMPTS) {
          // Zehirli güncelleme: 200 ile onaylanır ki Telegram sonsuza dek yeniden denemesin.
          await this.handler.recordSkipped(update.update_id, Number(attempts), err, 'webhook');
          return { ok: true };
        }
        // Hata yutulmaz: AllExceptionsFilter 500 döner, Telegram güncellemeyi yeniden dener.
        throw err;
      }
      await this.redis.del(failKey).catch(() => undefined);
    }
    return { ok: true };
  }
}
