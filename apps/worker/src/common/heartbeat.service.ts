import { hostname } from 'node:os';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../infra/redis.service';

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TTL_SEC = 45;
/** Ölü worker'ların admin listesinde görünmesi için son görülme kaydı bu kadar tutulur. */
export const WORKER_SEEN_TTL_SEC = 24 * 60 * 60;

/**
 * Admin panelinin canlı/ölü worker listesini Redis'teki bu anahtarlardan üretir (Plan 07):
 * `worker:heartbeat:<host>:<pid>` (TTL 45 sn, canlılık) ve `worker:seen:<host>:<pid>` (aynı JSON, TTL 24 saat).
 * Heartbeat'i bitmiş ama seen kaydı duran worker "ölü" listelenir. Düzgün kapanışta ikisi de silinir.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  readonly key = `worker:heartbeat:${hostname()}:${process.pid}`;
  readonly seenKey = `worker:seen:${hostname()}:${process.pid}`;
  private readonly logger = new Logger(HeartbeatService.name);
  private timer?: NodeJS.Timeout;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      this.beat().catch((err: unknown) => {
        this.logger.warn(`Heartbeat yazılamadı: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.redis.del(this.key, this.seenKey);
  }

  private async beat(): Promise<void> {
    const value = JSON.stringify({ role: this.env.ROLE, pid: process.pid, host: hostname(), startedAt: this.startedAt, at: new Date().toISOString() });
    await this.redis.multi().set(this.key, value, 'EX', HEARTBEAT_TTL_SEC).set(this.seenKey, value, 'EX', WORKER_SEEN_TTL_SEC).exec();
  }
}
