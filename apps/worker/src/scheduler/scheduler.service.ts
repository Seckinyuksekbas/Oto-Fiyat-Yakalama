import { Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '@oto/server-common';
import { SCRAPE_JOB_OPTS, scrapeQueueJobId } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { boundLocks, LOCK_TX_OPTIONS } from '../infra/tx-options';
import { QueueRegistry } from '../queues/queue-registry';

export const STALE_AFTER_MS = 30 * 60 * 1000;
/**
 * Bu yaştan büyük, BullMQ'da karşılığı olmayan QUEUED iş "yetim" sayılır (satır commit oldu ama kuyruğa eklenemeden süreç
 * hata aldı/çöktü). 2 dk: API/scheduler'ın satırı yazıp kuyruğa eklemesi arasındaki pencereden çok daha uzun.
 */
export const ORPHAN_AFTER_MS = 2 * 60 * 1000;
const ORPHAN_SCAN_LIMIT = 100;

export { scrapeQueueJobId };

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
    await this.recoverOrphanedJobs(now);
    const sources = await this.prisma.dataSource.findMany({
      where: { isActive: true, permissionVerifiedAt: { not: null }, health: { not: 'PAUSED' } },
    });
    let enqueued = 0;
    for (const source of sources) {
      // Kaynak satır kilidi: admin test taramasıyla iş oluşturma sıralanır (aynı anda iki iş oluşmaz).
      let job: { id: number } | null;
      try {
        job = await this.createDueJob(source, now);
      } catch (err) {
        // Commit olmuş ama hata dönmüş olabilir ("transaction already closed"): satır yetim kalırsa recoverOrphanedJobs toplar.
        this.logger.error(
          `Kaynak ${source.code} için iş oluşturulamadı: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!job) continue;
      try {
        await this.enqueue(job.id, source.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Kaynak ${source.code} için iş kuyruğa eklenemedi: ${message}`);
        await this.markEnqueueFailed(job.id, now, message);
        continue;
      }
      enqueued += 1;
    }
    return enqueued;
  }

  private createDueJob(
    source: { id: number; intervalSec: number },
    now: Date,
  ): Promise<{ id: number } | null> {
    return this.prisma.$transaction(async (tx) => {
      await boundLocks(tx);
      // Kilit altında uygunluğu yeniden oku: bu arada duraklatılmış/izni kalkmış kaynağa iş oluşturulmaz.
      const [fresh] = await tx.$queryRaw<{ isActive: boolean; health: string; permissionVerifiedAt: Date | null }[]>`
        SELECT "isActive", health::text AS health, "permissionVerifiedAt" FROM "DataSource" WHERE id = ${source.id} FOR NO KEY UPDATE`;
      if (!fresh || !fresh.isActive || fresh.health === 'PAUSED' || !fresh.permissionVerifiedAt) return null;
      // Uçuştaki herhangi bir iş (dry-run dahil) yeni zamanlanmış işi engeller.
      const inFlight = await tx.collectionJob.findFirst({
        where: { sourceId: source.id, status: { in: ['QUEUED', 'RUNNING'] } },
        select: { id: true },
      });
      if (inFlight) return null;
      // Aralık saati yalnızca dry-run olmayan işlerden hesaplanır (test taraması saati sıfırlamaz).
      const last = await tx.collectionJob.findFirst({
        where: { sourceId: source.id, dryRun: false },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last && now.getTime() - last.createdAt.getTime() < source.intervalSec * 1000) return null;
      return tx.collectionJob.create({
        data: { sourceId: source.id, trigger: 'SCHEDULED', createdAt: now },
        select: { id: true },
      });
    }, LOCK_TX_OPTIONS);
  }

  private async enqueue(collectionJobId: number, sourceId: number): Promise<void> {
    await this.queues.scrape.add(
      'scrape',
      { collectionJobId, sourceId },
      { jobId: scrapeQueueJobId(collectionJobId), ...SCRAPE_JOB_OPTS },
    );
  }

  private async markEnqueueFailed(id: number, now: Date, message: string): Promise<void> {
    await this.prisma.collectionJob.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        finishedAt: now,
        errorSummary: redactSecrets(`Kuyruğa eklenemedi: ${message}`).slice(0, 500),
      },
    });
  }

  /**
   * Yetim QUEUED işleri (ORPHAN_AFTER_MS'den eski, BullMQ'da işi yok) aynı deterministik jobId ile yeniden kuyruğa ekler;
   * ekleme de başarısızsa FAILED ("Kuyruğa eklenemedi") yapar ki kaynak 30 dk (STALE_AFTER_MS) bloke kalmasın.
   * İdempotent: işi zaten kuyrukta olan satıra dokunulmaz; aynı jobId ile ikinci ekleme BullMQ'da no-op'tur.
   * Dry-run (API test taraması) işleri de aynı kuyruğu/jobId'yi kullandığı için kapsanır.
   */
  async recoverOrphanedJobs(now: Date): Promise<number> {
    const candidates = await this.prisma.collectionJob.findMany({
      where: { status: 'QUEUED', createdAt: { lt: new Date(now.getTime() - ORPHAN_AFTER_MS) } },
      select: { id: true, sourceId: true },
      orderBy: { id: 'asc' },
      take: ORPHAN_SCAN_LIMIT,
    });
    let recovered = 0;
    for (const row of candidates) {
      try {
        if (await this.queues.scrape.getJob(scrapeQueueJobId(row.id))) continue;
        await this.enqueue(row.id, row.sourceId);
        recovered += 1;
        this.logger.warn(`Yetim tarama işi ${row.id} (kaynak ${row.sourceId}) yeniden kuyruğa eklendi`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Yetim tarama işi ${row.id} kuyruğa eklenemedi: ${message}`);
        await this.markEnqueueFailed(row.id, now, message);
      }
    }
    return recovered;
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
}
