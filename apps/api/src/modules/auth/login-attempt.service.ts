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
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, WINDOW_SEC);
    return count;
  }

  async clear(k: AttemptKey): Promise<void> {
    await this.redis.del(this.key(k));
  }
}
