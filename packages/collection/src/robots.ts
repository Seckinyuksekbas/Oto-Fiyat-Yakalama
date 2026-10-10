import type Redis from 'ioredis';
import robotsParser from 'robots-parser';
import { FetchError, toFetchError } from './errors';
import type { HttpResult } from './http-client';

const TTL_SEC = 24 * 60 * 60;

export class RobotsCache {
  constructor(
    private readonly redis: Redis,
    private readonly userAgent: string,
    private readonly fetcher: (url: string) => Promise<HttpResult>,
  ) {}

  async isAllowed(url: string): Promise<boolean> {
    const robotsUrl = new URL('/robots.txt', url).toString();
    const key = `robots:${new URL(url).origin}`;
    let body = await this.redis.get(key);
    if (body === null) {
      body = await this.load(robotsUrl);
      await this.redis.set(key, body, 'EX', TTL_SEC);
    }
    return robotsParser(robotsUrl, body).isAllowed(url, this.userAgent) !== false;
  }

  private async load(robotsUrl: string): Promise<string> {
    let res: HttpResult;
    try {
      res = await this.fetcher(robotsUrl);
    } catch (err) {
      throw toFetchError(err, robotsUrl);
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    // robots.txt yoksa (4xx) her şey serbesttir.
    if (res.status >= 400 && res.status < 500) return '';
    throw new FetchError('HTTP_5XX', `robots.txt alınamadı (HTTP ${res.status})`, robotsUrl, true);
  }
}
