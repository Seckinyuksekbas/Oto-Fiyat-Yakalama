import { Injectable, Logger } from '@nestjs/common';
import { analysisSettingsSchema, DEFAULT_SETTINGS, type AnalysisSettings } from '@oto/analysis';
import { PrismaService } from '../infra/prisma.service';

export const ANALYSIS_SETTINGS_KEY = 'analysis.settings';
const CACHE_MS = 60_000;

@Injectable()
export class AnalysisSettingsService {
  private readonly logger = new Logger(AnalysisSettingsService.name);
  private cache?: { at: number; value: AnalysisSettings };

  constructor(private readonly prisma: PrismaService) {}

  async get(now = Date.now()): Promise<AnalysisSettings> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ANALYSIS_SETTINGS_KEY } });
    let value = DEFAULT_SETTINGS;
    if (row) {
      const parsed = analysisSettingsSchema.safeParse(row.value);
      if (parsed.success) value = parsed.data;
      else this.logger.warn(`Geçersiz ${ANALYSIS_SETTINGS_KEY}; varsayılanlar kullanılıyor: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    this.cache = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
