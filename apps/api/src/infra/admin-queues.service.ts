import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { bullConnection } from '@oto/server-common';
import type { AdminQueueName } from '@oto/shared';
import { Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export const ADMIN_QUEUE_NAMES: readonly AdminQueueName[] = ['scrape', 'analyze', 'match', 'notify', 'notify-telegram'];

/**
 * Admin API'nin kuyruklara eriştiği Queue örnekleri (işleyici yok; yalnızca ekleme/inceleme/temizleme).
 * Kuyruklar ilk kullanımda oluşturulur (uygulama başına gereksiz bağlantı yok); üretici bağlantısı
 * Redis kapalıyken hızlı hata verir (kısa yeniden deneme, çevrimdışı kuyruk yok).
 */
@Injectable()
export class AdminQueues implements OnModuleDestroy {
  private readonly logger = new Logger(AdminQueues.name);
  private readonly queues = new Map<AdminQueueName, Queue>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  get(name: AdminQueueName): Queue {
    if (!ADMIN_QUEUE_NAMES.includes(name)) throw new Error(`Bilinmeyen kuyruk: ${name}`);
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: bullConnection(this.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }),
      });
      q.on('error', (err: Error) => this.logger.error(`Kuyruk hatası (${name}): ${err.message}`));
      this.queues.set(name, q);
    }
    return q;
  }

  get scrape(): Queue {
    return this.get('scrape');
  }
  get analyze(): Queue {
    return this.get('analyze');
  }
  get match(): Queue {
    return this.get('match');
  }
  get notify(): Queue {
    return this.get('notify');
  }
  get notifyTelegram(): Queue {
    return this.get('notify-telegram');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
