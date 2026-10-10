import type Redis from 'ioredis';

// Sıradaki boş zaman dilimini atomik olarak ayırır ve beklenmesi gereken ms'yi döner.
const RESERVE_SLOT = `
local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local gap = tonumber(ARGV[1])
local start = math.max(now, nextAt)
redis.call('SET', KEYS[1], start + gap, 'PX', start - now + gap + 60000)
return start - now
`;

/** Kaynak başına istekler arası asgari boşluk; tüm süreçler arasında Redis ile paylaşılır. */
export class SourceRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly sourceId: number,
    private readonly gapMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async acquire(): Promise<void> {
    if (this.gapMs <= 0) return;
    const wait = Number(await this.redis.eval(RESERVE_SLOT, 1, `ratelimit:source:${this.sourceId}`, this.gapMs));
    if (wait > 0) await this.sleep(wait);
  }
}
