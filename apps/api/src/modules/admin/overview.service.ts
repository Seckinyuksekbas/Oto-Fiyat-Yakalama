import { Injectable, Logger } from '@nestjs/common';
import { startOfIstanbulDay } from '@oto/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AdminQueuesService } from './queues.service';
import { AdminWorkersService } from './workers.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fırsat akışının varsayılan ölçütleri (me/opportunities ile aynı): skor ≥ 60, güven ≥ MEDIUM, aktif ilan. */
const OPPORTUNITY_MIN_SCORE = 60;
/** KPI özeti bağlantılar arasında bu süre paylaşılır (SSE tick aralığı kadar). */
export const KPI_CACHE_MS = 30_000;

export interface AdminKpi {
  notifications: { sentToday: number; failedToday: number; skippedLimitToday: number };
  /** Kuyruk adı → waiting + active + delayed (+ prioritized: BullMQ 5'te öncelikli bekleyenler ayrı sayılır). Redis'e erişilemezse null. */
  queues: Record<string, number> | null;
  /** Redis'e erişilemezse null. */
  workers: { alive: number; dead: number } | null;
  /** `isActive=false` yönetici duraklatmasıdır; `health=PAUSED` engel kaynaklıdır (ikisi ayrı gösterilir). */
  sources: Array<{ id: number; code: string; health: string; isActive: boolean; permissionVerifiedAt: Date | null; lastSuccessAt: Date | null }>;
}

export interface AdminOverview extends AdminKpi {
  users: { total: number; active: number; suspended: number; newToday: number };
  profiles: { active: number };
  listings: { active: number; newToday: number; removedToday: number };
  opportunities: { count: number };
  latency: { p50: number | null; p95: number | null };
}

/**
 * Admin genel bakış KPI'ları. "Bugün" İstanbul gününün başından itibarendir (`startOfIstanbulDay`; me/admin kota sayımlarıyla
 * aynı sınır). Bildirim sayıları kullanıcı bildirimleri (`MATCH`) içindir; SYSTEM_ALERT/SECURITY sayılmaz.
 * Gecikme p50/p95: son 24 saatte gönderilen MATCH bildirimlerinin `latencyMs` (= sentAt − eventAt) değerleri.
 * Kuyruk sayıları ve worker canlılığı AdminQueuesService / AdminWorkersService'ten gelir.
 */
@Injectable()
export class AdminOverviewService {
  private readonly logger = new Logger(AdminOverviewService.name);
  private kpiCache?: { at: number; value: Promise<AdminKpi> };

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: AdminQueuesService,
    private readonly workers: AdminWorkersService,
  ) {}

  async overview(now: Date = new Date()): Promise<AdminOverview> {
    const dayStart = startOfIstanbulDay(now);
    const [kpi, users, profiles, listings, opportunities, latency] = await Promise.all([
      this.kpi(now),
      this.userCounts(dayStart),
      this.prisma.searchProfile.count({ where: { status: 'ACTIVE' } }),
      this.listingCounts(dayStart),
      this.opportunityCount(),
      this.latency(now),
    ]);
    return {
      users,
      profiles: { active: profiles },
      listings,
      opportunities: { count: opportunities },
      notifications: kpi.notifications,
      queues: kpi.queues,
      sources: kpi.sources,
      workers: kpi.workers,
      latency,
    };
  }

  /**
   * SSE `kpi` olayı: tüm admin bağlantıları aynı hesaplamayı paylaşır (KPI_CACHE_MS boyunca tek hesaplama; uçuştaki
   * hesaplama da paylaşılır). Hata önbelleğe alınmaz.
   */
  cachedKpi(): Promise<AdminKpi> {
    const now = Date.now();
    if (this.kpiCache && now - this.kpiCache.at < KPI_CACHE_MS) return this.kpiCache.value;
    const value = this.kpi(new Date(now));
    const entry = { at: now, value };
    this.kpiCache = entry;
    value.catch(() => {
      if (this.kpiCache === entry) this.kpiCache = undefined;
    });
    return value;
  }

  /** SSE `kpi` olayının hafif alt kümesi. */
  async kpi(now: Date = new Date()): Promise<AdminKpi> {
    const dayStart = startOfIstanbulDay(now);
    const [notifications, queues, workers, sources] = await Promise.all([
      this.notificationCounts(dayStart),
      this.queueDepths(),
      this.workerCounts(),
      this.prisma.dataSource.findMany({ select: { id: true, code: true, health: true, isActive: true, permissionVerifiedAt: true, lastSuccessAt: true }, orderBy: { id: 'asc' } }),
    ]);
    return { notifications, queues, workers, sources };
  }

  private async userCounts(dayStart: Date) {
    const notDeleted = { status: { not: 'DELETED' as const } };
    const [total, active, suspended, newToday] = await Promise.all([
      this.prisma.user.count({ where: notDeleted }),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.user.count({ where: { ...notDeleted, createdAt: { gte: dayStart } } }),
    ]);
    return { total, active, suspended, newToday };
  }

  private async listingCounts(dayStart: Date) {
    const [active, newToday, removedToday] = await Promise.all([
      this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
      this.prisma.listing.count({ where: { firstSeenAt: { gte: dayStart } } }),
      this.prisma.listing.count({ where: { status: 'REMOVED', removedAt: { gte: dayStart } } }),
    ]);
    return { active, newToday, removedToday };
  }

  private async opportunityCount(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "Listing" l JOIN "ListingAnalysis" a ON a.id = l."latestAnalysisId"
      WHERE l.status = 'ACTIVE' AND a."opportunityScore" >= ${OPPORTUNITY_MIN_SCORE}
        AND confidence_rank(a.confidence::text) >= confidence_rank('MEDIUM')`;
    return row?.n ?? 0;
  }

  private async notificationCounts(dayStart: Date) {
    const [sentToday, failedToday, skippedLimitToday] = await Promise.all([
      this.prisma.notification.count({ where: { kind: 'MATCH', status: 'SENT', sentAt: { gte: dayStart } } }),
      this.prisma.notification.count({ where: { kind: 'MATCH', status: 'FAILED', createdAt: { gte: dayStart } } }),
      this.prisma.notification.count({ where: { kind: 'MATCH', status: 'SKIPPED_LIMIT', createdAt: { gte: dayStart } } }),
    ]);
    return { sentToday, failedToday, skippedLimitToday };
  }

  private async latency(now: Date): Promise<{ p50: number | null; p95: number | null }> {
    const since = new Date(now.getTime() - DAY_MS);
    const [row] = await this.prisma.$queryRaw<Array<{ p50: number | null; p95: number | null }>>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95
      FROM "Notification"
      WHERE kind = 'MATCH' AND status = 'SENT' AND "sentAt" >= ${since} AND "latencyMs" IS NOT NULL`;
    const r = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v)));
    return { p50: r(row?.p50), p95: r(row?.p95) };
  }

  private async queueDepths(): Promise<Record<string, number> | null> {
    try {
      const list = await this.queues.list();
      return Object.fromEntries(
        list.map((q) => [q.name, (q.counts.waiting ?? 0) + (q.counts.active ?? 0) + (q.counts.delayed ?? 0) + (q.counts.prioritized ?? 0)]),
      );
    } catch (err) {
      this.logger.warn(`Genel bakış: kuyruk sayıları okunamadı: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async workerCounts(): Promise<{ alive: number; dead: number } | null> {
    try {
      const list = await this.workers.list();
      const alive = list.filter((w) => w.alive).length;
      return { alive, dead: list.length - alive };
    } catch (err) {
      this.logger.warn(`Genel bakış: worker durumu okunamadı: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
