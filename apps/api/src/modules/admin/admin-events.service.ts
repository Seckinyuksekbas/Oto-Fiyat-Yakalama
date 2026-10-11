import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ADMIN_EVENTS_CHANNEL, adminEventSchema, type AdminEvent } from '@oto/shared';
import type Redis from 'ioredis';
import { Observable } from 'rxjs';
import { RedisService } from '../../infra/redis.service';

type Listener = (e: AdminEvent) => void;

/**
 * `admin:events` kanalına uygulama başına TEK Redis abonelik bağlantısı; her SSE bağlantısı yalnızca bir dinleyici ekler
 * ve bağlantı kapanınca dinleyici kaldırılır (bağlantı başına Redis bağlantısı/sızıntı yok). UserEventsService ile aynı desen.
 */
@Injectable()
export class AdminEventsService implements OnApplicationShutdown {
  private readonly logger = new Logger(AdminEventsService.name);
  private sub?: Redis;
  private subscribing?: Promise<void>;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly redis: RedisService) {}

  stream(): Observable<AdminEvent> {
    return new Observable<AdminEvent>((subscriber) => {
      this.subscribed().catch(() => undefined);
      const fn: Listener = (e) => subscriber.next(e);
      this.listeners.add(fn);
      return () => {
        this.listeners.delete(fn);
      };
    });
  }

  /** Test/izleme: açık admin akışı (dinleyici) sayısı. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Redis aboneliğinin kurulduğunu garanti eder; başarısızsa bağlantı kapatılır ve sonraki çağrı yeniden dener. */
  subscribed(): Promise<void> {
    if (this.subscribing) return this.subscribing;
    const sub = this.redis.duplicate();
    this.sub = sub;
    sub.on('error', (err: unknown) => this.logger.warn(`Admin olay aboneliği hatası: ${String(err)}`));
    sub.on('message', (_channel: string, message: string) => {
      if (this.listeners.size === 0) return;
      let parsed: AdminEvent;
      try {
        parsed = adminEventSchema.parse(JSON.parse(message));
      } catch {
        this.logger.warn('Geçersiz admin olayı yok sayıldı');
        return;
      }
      for (const fn of [...this.listeners]) fn(parsed);
    });
    const p = sub
      .subscribe(ADMIN_EVENTS_CHANNEL)
      .then(() => undefined)
      .catch((err: unknown) => {
        this.logger.error(`Admin olay aboneliği başarısız: ${String(err)}`);
        if (this.sub === sub) {
          this.sub = undefined;
          this.subscribing = undefined;
        }
        sub.disconnect();
        throw err;
      });
    this.subscribing = p;
    return p;
  }

  /** HTTP sunucusu kapandıktan sonra (SSE akışları ShutdownSignal ile bitmiş olur). */
  async onApplicationShutdown(): Promise<void> {
    await this.sub?.quit().catch(() => undefined);
  }
}
