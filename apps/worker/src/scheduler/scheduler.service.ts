import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { QueueRegistry } from '../queues/queue-registry';

export const STALE_AFTER_MS = 30 * 60 * 1000;
export const RETENTION_DAYS = 30;

export function scrapeQueueJobId(collectionJobId: number): string {
  return `scrape-${collectionJobId}`;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** Zamanı gelen her kaynak için bir CollectionJob + scrape işi üretir. Dönen değer: kuyruğa eklenen iş sayısı. */
  async tick(now: Date = new Date()): Promise<number> {
    await this.failStaleJobs(now);
    const sources = await this.prisma.dataSource.findMany({
      where: { isActive: true, permissionVerifiedAt: { not: null }, health: { not: 'PAUSED' } },
    });
    let enqueued = 0;
    for (const source of sources) {
      // Kaynak satır kilidi: admin test taramasıyla iş oluşturma sıralanır (aynı anda iki iş oluşmaz).
      const job = await this.prisma.$transaction(async (tx) => {
        // Kilit altında uygunluğu yeniden oku: bu arada duraklatılmış/izni kalkmış kaynağa iş oluşturulmaz.
        const [fresh] = await tx.$queryRaw<{ isActive: boolean; health: string; permissionVerifiedAt: Date | null }[]>`
          SELECT "isActive", health::text AS health, "permissionVerifiedAt" FROM "DataSource" WHERE id = ${source.id} FOR NO KEY UPDATE`;
        if (!fresh || !fresh.isActive || fresh.health === 'PAUSED' || !fresh.permissionVerifiedAt) return null;
        // Uçuştaki herhangi bir iş (dry-run dahil) yeni zamanlanmış işi engeller.
        const inFlight = await tx.collectionJob.findFirst({ where: { sourceId: source.id, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
        if (inFlight) return null;
        // Aralık saati yalnızca dry-run olmayan işlerden hesaplanır (test taraması saati sıfırlamaz).
        const last = await tx.collectionJob.findFirst({ where: { sourceId: source.id, dryRun: false }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
        if (last && now.getTime() - last.createdAt.getTime() < source.intervalSec * 1000) return null;
        return tx.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', createdAt: now } });
      });
      if (!job) continue;
      try {
        await this.queues.scrape.add(
          'scrape',
          { collectionJobId: job.id, sourceId: source.id },
          { jobId: scrapeQueueJobId(job.id), removeOnComplete: { age: 24 * 60 * 60 }, removeOnFail: { age: 7 * 24 * 60 * 60 } },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Kaynak ${source.code} için iş kuyruğa eklenemedi: ${message}`);
        await this.prisma.collectionJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', finishedAt: now, errorSummary: `Kuyruğa eklenemedi: ${message}` },
        });
        continue;
      }
      enqueued += 1;
    }
    return enqueued;
  }

  /** Çöken bir worker'ın bıraktığı işleri kapatır; aksi halde kaynak sonsuza dek "meşgul" görünür. */
  async failStaleJobs(now: Date): Promise<number> {
    const { count } = await this.prisma.collectionJob.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
      data: { status: 'FAILED', finishedAt: now, errorSummary: 'İş zaman aşımına uğradı (worker çökmüş olabilir)' },
    });
    if (count > 0) this.logger.warn(`${count} eski tarama işi FAILED olarak kapatıldı`);
    return count;
  }

  async cleanup(now: Date = new Date()): Promise<{ systemLogs: number; scrapeErrors: number; listingIssues: number }> {
    const before = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const [systemLogs, scrapeErrors, listingIssues] = await Promise.all([
      this.prisma.systemLog.deleteMany({ where: { createdAt: { lt: before } } }),
      this.prisma.scrapeError.deleteMany({ where: { createdAt: { lt: before } } }),
      this.prisma.listingIssue.deleteMany({ where: { createdAt: { lt: before } } }),
    ]);
    return { systemLogs: systemLogs.count, scrapeErrors: scrapeErrors.count, listingIssues: listingIssues.count };
  }
}
