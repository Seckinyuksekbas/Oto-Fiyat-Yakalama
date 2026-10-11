import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export const LEADER_LOCK_KEY = 'scheduler:leader';
export const LEADER_LOCK_TTL_MS = 30_000;
export const LEADER_LOCK_RENEW_MS = 10_000;
export const LEADER_LOCK_OPTIONS = Symbol('LEADER_LOCK_OPTIONS');

export interface LeaderLockOptions {
  ttlMs?: number;
  renewMs?: number;
}

/** Yalnız değer hâlâ bizimse süreyi uzatır (compare-and-swap). */
const RENEW_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
/** Yalnız değer hâlâ bizimse siler (compare-and-delete); başkasının kilidine dokunmaz. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Scheduler tekliği: birden çok scheduler süreci çalışsa da yalnız `scheduler:leader` kilidini tutan tick/monitor/temizlik
 * yapar. Kilit `SET NX PX 30000` ile alınır, `renewMs`'de bir Lua CAS ile yenilenir; lider olmayan aynı aralıkla yeniden
 * dener. Yenileme başarısız olursa (kilit başkasında/silinmiş) liderlik hemen bırakılır. Redis'e ulaşılamazsa son başarılı
 * alma/yenilemeden itibaren TTL dolunca kendini lider saymaz (bu arada kilit başka bir sürece geçmiş olabilir).
 *
 * Kendi Redis bağlantısını kullanır: Nest kapanışında paylaşılan `RedisService` `onModuleDestroy`'da kapanır, kilit ise
 * `onApplicationShutdown`'da (daha sonra) bırakılır.
 */
@Injectable()
export class LeaderLockService implements OnApplicationShutdown {
  readonly value = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly logger = new Logger(LeaderLockService.name);
  private readonly redis: Redis;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly leaseMs: number;
  private leader = false;
  /**
   * Bu ana kadar kilidin bizde olduğu kesin: son başarılı SET/PEXPIRE başlangıcı + TTL − güvenlik payı
   * (saat kayması / Redis gecikmesi için 1 sn; çok kısa test TTL'lerinde TTL'nin %10'u).
   */
  private leaseUntil = 0;
  /** null: henüz bir durum loglanmadı (ilk standby da loglanır). */
  private announced: 'leader' | 'standby' | null = null;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<boolean>;
  private stopped = false;
  private readonly acquiredListeners: (() => void)[] = [];

  constructor(@Inject(ENV) env: Env, @Optional() @Inject(LEADER_LOCK_OPTIONS) opts?: LeaderLockOptions) {
    this.ttlMs = opts?.ttlMs ?? LEADER_LOCK_TTL_MS;
    this.renewMs = opts?.renewMs ?? LEADER_LOCK_RENEW_MS;
    this.leaseMs = this.ttlMs - Math.min(1000, Math.floor(this.ttlMs / 10));
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
    this.redis.on('error', (err: Error) => this.logger.error(`Lider kilidi Redis hatası: ${err.message}`));
  }

  isLeader(): boolean {
    return this.leader && Date.now() < this.leaseUntil;
  }

  /** Lider olunca (standby → leader geçişi) çağrılır. */
  onAcquired(listener: () => void): void {
    this.acquiredListeners.push(listener);
  }

  /** İlk denemeyi yapar ve periyodik yenileme/yeniden denemeyi başlatır. Redis hatası açılışı durdurmaz (standby kalınır). */
  async start(): Promise<void> {
    await this.attempt();
    this.timer ??= setInterval(() => void this.attempt(), this.renewMs);
  }

  /** Liderse kilidi yeniler, değilse almayı dener. Dönen değer: bu çağrı sonunda lider mi. */
  tryAcquire(): Promise<boolean> {
    this.inFlight ??= this.acquireOrRenew().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async release(): Promise<void> {
    const wasLeader = this.leader;
    this.leader = false;
    this.leaseUntil = 0;
    if (wasLeader) this.announced = null;
    await this.redis.eval(RELEASE_SCRIPT, 1, LEADER_LOCK_KEY, this.value);
    if (wasLeader) this.logger.log('scheduler leader lock released');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
    try {
      if (this.redis.status === 'ready') await this.release();
    } catch (err) {
      this.logger.warn(`Lider kilidi bırakılamadı (TTL dolunca serbest kalır): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.redis.disconnect();
    }
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tryAcquire();
    } catch (err) {
      this.logger.warn(`Lider kilidi denenemedi: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async acquireOrRenew(): Promise<boolean> {
    const startedAt = Date.now();
    if (this.leader) {
      const renewed = await this.redis.eval(RENEW_SCRIPT, 1, LEADER_LOCK_KEY, this.value, String(this.ttlMs));
      if (renewed === 1) {
        this.leaseUntil = startedAt + this.leaseMs;
        return true;
      }
      this.leader = false;
      this.leaseUntil = 0;
      this.announced = 'standby';
      this.logger.warn('scheduler leader lock lost; ticking stopped, retrying as standby');
      // Kilit yalnız süresi dolduğu için kaybolduysa (ör. uzun GC duraklaması) aynı çağrıda yeniden alınmayı dener.
    }
    if (this.stopped) return false;
    const ok = await this.redis.set(LEADER_LOCK_KEY, this.value, 'PX', this.ttlMs, 'NX');
    if (ok === 'OK') {
      this.leader = true;
      this.leaseUntil = startedAt + this.leaseMs;
      this.announced = 'leader';
      this.logger.log('scheduler leader acquired');
      for (const listener of this.acquiredListeners) listener();
      return true;
    }
    if (this.announced !== 'standby') {
      this.announced = 'standby';
      this.logger.log('scheduler standby: leader lock held by another instance');
    }
    return false;
  }
}
