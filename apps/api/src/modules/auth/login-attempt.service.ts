import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis.service';

export const LOCK_THRESHOLD = 5;
const WINDOW_SEC = 15 * 60;

export interface AttemptKey {
  ip: string;
  email: string;
}

@Injectable()
export class LoginAttemptService {
  constructor(private readonly redis: RedisService) {}

  private key(k: AttemptKey): string {
    return `auth:fail:${k.ip}:${k.email}`;
  }

  async isLocked(k: AttemptKey): Promise<boolean> {
    return Number((await this.redis.get(this.key(k))) ?? 0) >= LOCK_THRESHOLD;
  }

  /** Pencere ilk hatada başlar; yeni hatalar süreyi uzatmaz. */
  async recordFailure(k: AttemptKey): Promise<number> {
    const key = this.key(k);
    // INCR + EXPIRE NX in one MULTI: atomic, so a crash can never leave a TTL-less counter.
    const results = await this.redis.multi().incr(key).expire(key, WINDOW_SEC, 'NX').exec();
    const [err, count] = results?.[0] ?? [new Error('redis multi failed'), 0];
    if (err) throw err;
    return Number(count);
  }

  async clear(k: AttemptKey): Promise<void> {
    await this.redis.del(this.key(k));
  }
}
