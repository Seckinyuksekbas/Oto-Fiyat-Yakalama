import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { TelegramApiError, type TelegramClient, type TelegramUpdate } from '@oto/telegram';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { TELEGRAM_API, TELEGRAM_POLLING_AUTOSTART } from './telegram.config';
import { HANDLER_MAX_ATTEMPTS } from './telegram-errors';
import { TelegramUpdateHandler } from './telegram-update.handler';

export const POLL_ERROR_WAIT_MS = 5_000;
export const POLL_CONFLICT_WAIT_MS = 30_000;
export const POLL_UNAUTHORIZED_WAIT_MS = 60_000;
export const HANDLER_RETRY_BASE_MS = 1_000;
export const HANDLER_RETRY_MAX_MS = 30_000;

@Injectable()
export class TelegramPollingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPollingService.name);
  private abort?: AbortController;
  private loop?: Promise<void>;
  private offset = 0;
  /** Testlerde bekleme sürelerini kısaltmak için. */
  errorWaitMs = POLL_ERROR_WAIT_MS;
  conflictWaitMs = POLL_CONFLICT_WAIT_MS;
  unauthorizedWaitMs = POLL_UNAUTHORIZED_WAIT_MS;
  handlerRetryBaseMs = HANDLER_RETRY_BASE_MS;
  maxHandlerAttempts = HANDLER_MAX_ATTEMPTS;
  /** Başarısız olan güncellemenin kimliği ve deneme sayısı. */
  private failing?: { updateId: number; attempts: number };

  constructor(
    @Inject(TELEGRAM_API) private readonly bot: TelegramClient | null,
    @Inject(ENV) private readonly env: Env,
    @Inject(TELEGRAM_POLLING_AUTOSTART) private readonly autostart: boolean,
    private readonly handler: TelegramUpdateHandler,
  ) {}

  onApplicationBootstrap(): void {
    if (this.autostart && this.env.TELEGRAM_MODE === 'polling') this.start();
  }

  /** Döngüyü başlatır (zaten çalışıyorsa veya bot yoksa no-op). */
  start(): void {
    if (!this.bot || this.loop) return;
    this.abort = new AbortController();
    this.loop = this.run(this.bot, this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop;
    this.loop = undefined;
    this.abort = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async run(bot: TelegramClient, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await bot.getUpdates(this.offset, 25, signal);
        for (const u of updates) {
          if (!(await this.process(u, signal))) break;
        }
      } catch (err) {
        if (signal.aborted) return;
        let wait = this.errorWaitMs;
        if (err instanceof TelegramApiError && err.status === 409) {
          wait = this.conflictWaitMs;
          this.logger.warn('getUpdates 409: webhook tanımlı veya başka bir yoklayıcı çalışıyor; bekleniyor');
        } else if (err instanceof TelegramApiError && err.status === 401) {
          wait = this.unauthorizedWaitMs;
          this.logger.error('getUpdates 401: bot token geçersiz');
        } else if (err instanceof TelegramApiError && err.status === 429) {
          wait = Math.max(this.errorWaitMs, (err.retryAfterSec ?? 0) * 1000);
          this.logger.warn(`getUpdates 429: ${wait} ms bekleniyor`);
        } else {
          this.logger.warn(`getUpdates başarısız: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.sleep(wait, signal);
      }
    }
  }

  /**
   * Güncellemeyi işler. Başarıda (ya da deneme sınırı aşılıp atlandığında) offset ilerler ve true döner.
   * Hata durumunda offset İLERLEMEZ: geri çekilip false döner, sonraki getUpdates aynı güncellemeyi yeniden getirir.
   */
  private async process(u: TelegramUpdate, signal: AbortSignal): Promise<boolean> {
    try {
      await this.handler.handle(u);
    } catch (err) {
      if (signal.aborted) return false;
      const attempts = this.failing?.updateId === u.update_id ? this.failing.attempts + 1 : 1;
      const reason = err instanceof Error ? err.message : String(err);
      if (attempts < this.maxHandlerAttempts) {
        this.failing = { updateId: u.update_id, attempts };
        const wait = Math.min(this.handlerRetryBaseMs * 2 ** (attempts - 1), HANDLER_RETRY_MAX_MS);
        this.logger.warn(`Telegram güncellemesi işlenemedi (update_id=${u.update_id}, deneme ${attempts}/${this.maxHandlerAttempts}); ${wait} ms sonra yeniden denenecek: ${reason}`);
        await this.sleep(wait, signal);
        return false;
      }
      await this.handler.recordSkipped(u.update_id, attempts, err, 'polling');
    }
    this.failing = undefined;
    this.offset = Math.max(this.offset, u.update_id + 1);
    return true;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
