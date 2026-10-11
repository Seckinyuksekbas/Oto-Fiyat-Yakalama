import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { analysisSettingsSchema, DEFAULT_SETTINGS, type AnalysisSettings } from '@oto/analysis';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

export const ANALYSIS_SETTINGS_KEY = 'analysis.settings';
const CACHE_MS = 60_000;
/** API ayar kaydından sonra yayınlar; mesaj = değişen anahtar. */
export const SETTINGS_CHANGED_CHANNEL = 'settings:changed';

@Injectable()
export class AnalysisSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalysisSettingsService.name);
  private cache?: { at: number; value: AnalysisSettings };
  /** invalidate() her çağrıda artar; uçuştaki bir okuma, bu sırada geçersiz kılındıysa sonucunu önbelleğe yazmaz. */
  private generation = 0;
  private subscribed = false;

  private subscriber?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Abonelik bağlantısı komut bağlantısından ayrı olmalı (subscribe modunda komut çalışmaz). 60 sn TTL yedek kalır. */
  async onModuleInit(): Promise<void> {
    const sub = this.redis.duplicate();
    sub.on('error', (err: Error) => this.logger.warn(`Ayar aboneliği hatası: ${err.message}`));
    sub.on('message', (_channel: string, key: string) => {
      if (key === ANALYSIS_SETTINGS_KEY) this.invalidate();
    });
    // Bağlantı sonradan (ilk abonelik başarısızsa) hazır olduğunda yeniden abone ol; kaçırılmış mesajlar için önbelleği at.
    sub.on('ready', () => {
      if (this.subscribed) return;
      void this.subscribe(sub);
    });
    this.subscriber = sub;
    await this.subscribe(sub);
  }

  private async subscribe(sub: Redis): Promise<void> {
    try {
      await sub.subscribe(SETTINGS_CHANGED_CHANNEL);
      this.subscribed = true;
      this.invalidate();
    } catch (err) {
      this.logger.warn(`settings:changed aboneliği kurulamadı; 'ready' olunca yeniden denenecek, o zamana dek yalnızca TTL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = undefined;
    if (sub) await sub.quit().catch(() => undefined);
  }

  async get(now = Date.now()): Promise<AnalysisSettings> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
    const generation = this.generation;
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ANALYSIS_SETTINGS_KEY } });
    let value = DEFAULT_SETTINGS;
    if (row) {
      const parsed = analysisSettingsSchema.safeParse(row.value);
      if (parsed.success) value = parsed.data;
      else this.logger.warn(`Geçersiz ${ANALYSIS_SETTINGS_KEY}; varsayılanlar kullanılıyor: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    if (generation === this.generation) this.cache = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.generation += 1;
    this.cache = undefined;
  }
}
