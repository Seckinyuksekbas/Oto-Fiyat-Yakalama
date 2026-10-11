import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { AdminQueueName } from '@oto/shared';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

/** BullMQ bağlantısı: engelleyici komutlar için maxRetriesPerRequest null (worker ile aynı). */
export function bullConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

export const ADMIN_QUEUE_NAMES: readonly AdminQueueName[] = ['scrape', 'analyze', 'match', 'notify', 'notify-telegram'];

/** Admin API'nin kuyruklara eriştiği Queue örnekleri (işleyici yok; yalnızca ekleme/inceleme/temizleme). */
@Injectable()
export class AdminQueues implements OnModuleDestroy {
  private readonly logger = new Logger(AdminQueues.name);
  private readonly queues = new Map<AdminQueueName, Queue>();
  readonly scrape: Queue;
  readonly analyze: Queue;
  readonly match: Queue;
  readonly notify: Queue;
  readonly notifyTelegram: Queue;

  constructor(@Inject(ENV) env: Env) {
    const connection = bullConnection(env.REDIS_URL);
    for (const name of ADMIN_QUEUE_NAMES) {
      const q = new Queue(name, { connection });
      q.on('error', (err: Error) => this.logger.error(`Kuyruk hatası (${name}): ${err.message}`));
      this.queues.set(name, q);
    }
    this.scrape = this.get('scrape');
    this.analyze = this.get('analyze');
    this.match = this.get('match');
    this.notify = this.get('notify');
    this.notifyTelegram = this.get('notify-telegram');
  }

  get(name: AdminQueueName): Queue {
    const q = this.queues.get(name);
    if (!q) throw new Error(`Bilinmeyen kuyruk: ${name}`);
    return q;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
