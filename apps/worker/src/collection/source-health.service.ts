import { Injectable } from '@nestjs/common';
import { FetchError } from '@oto/collection';
import type { DataSource, Prisma, SourceHealth } from '@oto/db';
import { redactSecrets } from '@oto/server-common';
import { AlertService, PERSISTENT_ALERT_TTL_SEC } from '../common/alert.service';
import { PrismaService } from '../infra/prisma.service';

export const PARSE_ISSUE_THRESHOLD = 0.2;
export const DEGRADED_AFTER = 3;
export const DOWN_AFTER = 6;

/**
 * Kaynak sağlığının oku-değiştir-yaz güncellemeleri. Her güncelleme satırı `FOR NO KEY UPDATE` ile kilitleyen bir işlemde
 * yapılır (admin activate/pause ve zamanlayıcı ile aynı kilit): eşzamanlı bir admin işlemi eski okunan durumla ezilmez.
 * Alarmlar işlem commit edildikten sonra verilir.
 */
@Injectable()
export class SourceHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  private async withLockedSource<T>(sourceId: number, fn: (tx: Prisma.TransactionClient, source: DataSource) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DataSource" WHERE id = ${sourceId} FOR NO KEY UPDATE`;
      const source = await tx.dataSource.findUniqueOrThrow({ where: { id: sourceId } });
      return fn(tx, source);
    });
  }

  async recordSuccess(sourceId: number, issueRate: number): Promise<void> {
    const degraded = issueRate > PARSE_ISSUE_THRESHOLD;
    const source = await this.withLockedSource(sourceId, async (tx, s) => {
      const health: SourceHealth = s.health === 'PAUSED' ? 'PAUSED' : degraded ? 'DEGRADED' : 'HEALTHY';
      await tx.dataSource.update({ where: { id: sourceId }, data: { consecutiveFailures: 0, lastSuccessAt: new Date(), health } });
      return s;
    });
    if (degraded) {
      await this.alerts.raise({
        key: `source:${sourceId}:parse`,
        level: 'WARN',
        component: 'collection',
        message: `${source.name}: ilanların %${Math.round(issueRate * 100)}'i ayrıştırılamadı veya doğrulanamadı; sayfa yapısı değişmiş olabilir.`,
        context: { sourceId, issueRate },
      });
    }
  }

  /** Sayfa yapısı tanınmadı: ardışık hata sayacını beklemeden kaynağı hemen DEGRADED yapar ve uyarır. */
  async recordLayoutBreak(sourceId: number, err: Error): Promise<void> {
    const source = await this.withLockedSource(sourceId, async (tx, s) => {
      const health: SourceHealth = s.health === 'PAUSED' || s.health === 'DOWN' ? s.health : 'DEGRADED';
      await tx.dataSource.update({ where: { id: sourceId }, data: { lastErrorAt: new Date(), health } });
      return s;
    });
    await this.alerts.raise({
      key: `source:${sourceId}:parse`,
      level: 'WARN',
      component: 'collection',
      message: `${source.name}: sayfa yapısı tanınmadı; kaynak sitenin düzeni değişmiş olabilir.`,
      context: { sourceId, error: redactSecrets(err.message).slice(0, 300) },
    });
  }

  async recordFailure(sourceId: number, err: Error): Promise<void> {
    const blocked = err instanceof FetchError && err.kind === 'BLOCKED';
    const { source, failures, health } = await this.withLockedSource(sourceId, async (tx, s) => {
      const failures = s.consecutiveFailures + 1;
      let health: SourceHealth = s.health;
      if (blocked || s.health === 'PAUSED') health = 'PAUSED';
      else if (failures >= DOWN_AFTER) health = 'DOWN';
      else if (failures >= DEGRADED_AFTER) health = 'DEGRADED';
      await tx.dataSource.update({ where: { id: sourceId }, data: { consecutiveFailures: failures, lastErrorAt: new Date(), health } });
      return { source: s, failures, health };
    });

    const context = { sourceId, failures, error: redactSecrets(err.message).slice(0, 300) };
    if (blocked) {
      await this.alerts.raise({
        key: `source:${sourceId}:blocked`,
        level: 'ERROR',
        component: 'collection',
        message: `${source.name} erişimimizi engelledi; kaynak duraklatıldı ve yeniden denenmeyecek. Kaynağın kullanım koşullarını ve iznini kontrol edin.`,
        context,
        ttlSec: PERSISTENT_ALERT_TTL_SEC,
      });
    } else if (health === 'DOWN' && source.health !== 'DOWN') {
      await this.alerts.raise({
        key: `source:${sourceId}:down`,
        level: 'ERROR',
        component: 'collection',
        message: `${source.name} ${failures} kez üst üste başarısız oldu; kaynak DOWN.`,
        context,
        ttlSec: PERSISTENT_ALERT_TTL_SEC,
      });
    } else if (health === 'DEGRADED' && source.health !== 'DEGRADED') {
      await this.alerts.raise({ key: `source:${sourceId}:degraded`, level: 'WARN', component: 'collection', message: `${source.name} ${failures} kez üst üste başarısız oldu.`, context });
    }
  }
}
