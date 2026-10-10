import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { userEventChannel, userEventSchema, type UserEvent } from '@oto/shared';
import type Redis from 'ioredis';
import { Observable } from 'rxjs';
import { RedisService } from './redis.service';

type Listener = (e: UserEvent) => void;

@Injectable()
export class UserEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(UserEventsService.name);
  private sub?: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly redis: RedisService) {}

  async publish(userId: string, event: UserEvent): Promise<void> {
    await this.redis.publish(userEventChannel(userId), JSON.stringify(event));
  }

  stream(userId: string): Observable<UserEvent> {
    return new Observable<UserEvent>((subscriber) => {
      this.ensureSubscribed();
      const fn: Listener = (e) => subscriber.next(e);
      const set = this.listeners.get(userId) ?? new Set<Listener>();
      set.add(fn);
      this.listeners.set(userId, set);
      return () => {
        set.delete(fn);
        if (set.size === 0 && this.listeners.get(userId) === set) this.listeners.delete(userId);
      };
    });
  }

  /** Test/izleme: açık akış (dinleyici) sayısı; userId verilmezse toplam. */
  listenerCount(userId?: string): number {
    if (userId) return this.listeners.get(userId)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  private ensureSubscribed(): void {
    if (this.sub) return;
    this.sub = this.redis.duplicate();
    void this.sub
      .psubscribe(userEventChannel('*'))
      .catch((err: unknown) => this.logger.error(`Abonelik başarısız: ${String(err)}`));
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const userId = channel.slice(userEventChannel('').length);
      const set = this.listeners.get(userId);
      if (!set?.size) return;
      let parsed: UserEvent;
      try {
        parsed = userEventSchema.parse(JSON.parse(message));
      } catch {
        this.logger.warn(`Geçersiz kullanıcı olayı yok sayıldı (${channel})`);
        return;
      }
      for (const fn of [...set]) fn(parsed);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.sub?.quit().catch(() => undefined);
  }
}
