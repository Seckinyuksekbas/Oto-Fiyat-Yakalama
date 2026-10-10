import { Injectable } from '@nestjs/common';
import { FetchError } from '@oto/collection';
import type { SourceHealth } from '@oto/db';
import { AlertService } from '../common/alert.service';
import { PrismaService } from '../infra/prisma.service';

export const PARSE_ISSUE_THRESHOLD = 0.2;
export const DEGRADED_AFTER = 3;
export const DOWN_AFTER = 6;

@Injectable()
export class SourceHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  async recordSuccess(sourceId: number, issueRate: number): Promise<void> {
    const source = await this.prisma.dataSource.findUniqueOrThrow({ where: { id: sourceId } });
    const degraded = issueRate > PARSE_ISSUE_THRESHOLD;
    const health: SourceHealth = source.health === 'PAUSED' ? 'PAUSED' : degraded ? 'DEGRADED' : 'HEALTHY';
    await this.prisma.dataSource.update({
      where: { id: sourceId },
      data: { consecutiveFailures: 0, lastSuccessAt: new Date(), health },
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

  async recordFailure(sourceId: number, err: Error): Promise<void> {
    const source = await this.prisma.dataSource.findUniqueOrThrow({ where: { id: sourceId } });
    const failures = source.consecutiveFailures + 1;
    const blocked = err instanceof FetchError && err.kind === 'BLOCKED';
    let health: SourceHealth = source.health;
    if (blocked || source.health === 'PAUSED') health = 'PAUSED';
    else if (failures >= DOWN_AFTER) health = 'DOWN';
    else if (failures >= DEGRADED_AFTER) health = 'DEGRADED';
    await this.prisma.dataSource.update({
      where: { id: sourceId },
      data: { consecutiveFailures: failures, lastErrorAt: new Date(), health },
    });

    const context = { sourceId, failures, error: err.message.slice(0, 300) };
    if (blocked) {
      await this.alerts.raise({
        key: `source:${sourceId}:blocked`,
        level: 'ERROR',
        component: 'collection',
        message: `${source.name} erişimimizi engelledi; kaynak duraklatıldı ve yeniden denenmeyecek. Kaynağın kullanım koşullarını ve iznini kontrol edin.`,
        context,
      });
    } else if (health === 'DOWN' && source.health !== 'DOWN') {
      await this.alerts.raise({ key: `source:${sourceId}:down`, level: 'ERROR', component: 'collection', message: `${source.name} ${failures} kez üst üste başarısız oldu; kaynak DOWN.`, context });
    } else if (health === 'DEGRADED' && source.health !== 'DEGRADED') {
      await this.alerts.raise({ key: `source:${sourceId}:degraded`, level: 'WARN', component: 'collection', message: `${source.name} ${failures} kez üst üste başarısız oldu.`, context });
    }
  }
}
