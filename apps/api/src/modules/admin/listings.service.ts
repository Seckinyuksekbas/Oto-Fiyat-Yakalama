import { Injectable } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import {
  ErrorCode,
  escapeLike,
  RETRYING_JOB_OPTS,
  type AdminAnalysesQuery,
  type AdminListingIssuesQuery,
  type AdminListingsQuery,
  type ListingCard,
} from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError, Errors } from '../../common/errors/app-error';
import { AdminQueues } from '../../infra/admin-queues.service';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import { toAnalysisSummary, toListingCard } from '../me/listing-card.view';

const REANALYZE_DEDUPE_SEC = 60;
const HISTORY_LIMIT = 50;
const PRICE_HISTORY_LIMIT = 500;
const ISSUE_LIMIT = 50;

/** Anahtar bu süreden (sn) eskiyse ve iş kuyrukta yoksa yetim sayılır. */
const PHANTOM_GRACE_SEC = 5;
class EnqueueFailed extends Error {}
const reanalyzeKey = (listingId: number) => `admin:reanalyze:${listingId}`;
const unavailable = () => new AppError(ErrorCode.INTERNAL, 503, 'Yeniden analiz şu anda kuyruğa alınamıyor');

@Injectable()
export class AdminListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: AdminQueues,
    private readonly audit: AuditService,
  ) {}

  async list(q: AdminListingsQuery) {
    const and: Prisma.ListingWhereInput[] = [];
    if (q.hasIssues) and.push(q.hasIssues === 'true' ? { issues: { some: {} } } : { issues: { none: {} } });
    // Prisma `contains` joker karakterleri kaçışlamaz: % ve _ burada kaçışlanır.
    if (q.q) and.push({ title: { contains: escapeLike(q.q), mode: 'insensitive' } });
    const where: Prisma.ListingWhereInput = {
      ...(q.source ? { sourceId: q.source } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.make ? { make: { equals: q.make, mode: 'insensitive' } } : {}),
      ...(q.model ? { model: { equals: q.model, mode: 'insensitive' } } : {}),
      AND: and,
    };
    const [total, rows] = await Promise.all([
      this.prisma.listing.count({ where }),
      this.prisma.listing.findMany({
        where,
        include: { latestAnalysis: true, source: { select: { code: true } }, _count: { select: { issues: true } } },
        orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const items = rows.map((l) => ({
      ...toListingCard(l, l.latestAnalysis, false),
      sourceId: l.sourceId,
      sourceCode: l.source.code,
      issueCount: l._count.issues,
    }));
    return { items, total };
  }

  async get(id: number) {
    const l = await this.prisma.listing.findUnique({
      where: { id },
      include: {
        latestAnalysis: true,
        source: { select: { code: true } },
        _count: { select: { matches: true } },
        analyses: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY_LIMIT },
        priceHistory: { orderBy: { observedAt: 'desc' }, take: PRICE_HISTORY_LIMIT },
        issues: { orderBy: { createdAt: 'desc' }, take: ISSUE_LIMIT },
      },
    });
    if (!l) throw Errors.notFound();
    const card: ListingCard = toListingCard(l, l.latestAnalysis, false);
    return {
      listing: {
        ...card,
        sourceId: l.sourceId,
        sourceCode: l.source.code,
        externalId: l.externalId,
        bodyType: l.bodyType,
        color: l.color,
        sellerType: l.sellerType,
        damageInfo: l.damageInfo as unknown,
        currency: l.currency,
        lastSeenAt: l.lastSeenAt.toISOString(),
        removedAt: l.removedAt?.toISOString() ?? null,
        relistedAt: l.relistedAt?.toISOString() ?? null,
        latestAnalysisId: l.latestAnalysisId,
        matchCount: l._count.matches,
      },
      // Geçmişte explanation döndürülmez (yalnızca özet için sunucuda okunur); tekil analiz uç noktası ekler.
      analyses: l.analyses.map((a) => ({
        id: a.id,
        createdAt: a.createdAt.toISOString(),
        engineVersion: a.engineVersion,
        matchEvent: a.matchEvent,
        listingPrice: a.listingPrice?.toString() ?? null,
        ...toAnalysisSummary(a),
      })),
      priceHistory: l.priceHistory.map((p) => ({ price: p.price.toString(), km: p.km, observedAt: p.observedAt.toISOString() })),
      issues: l.issues.map((i) => ({
        id: i.id,
        field: i.field,
        problem: i.problem,
        externalId: i.externalId,
        rawSnippet: i.rawSnippet,
        createdAt: i.createdAt.toISOString(),
      })),
    };
  }

  async issues(q: AdminListingIssuesQuery) {
    const where: Prisma.ListingIssueWhereInput = {
      ...(q.source ? { sourceId: q.source } : {}),
      ...(q.field ? { field: q.field } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.listingIssue.count({ where }),
      this.prisma.listingIssue.findMany({
        where,
        include: { source: { select: { code: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((i) => ({
        id: i.id,
        sourceId: i.sourceId,
        sourceCode: i.source.code,
        listingId: i.listingId,
        externalId: i.externalId,
        field: i.field,
        problem: i.problem,
        rawSnippet: i.rawSnippet,
        createdAt: i.createdAt.toISOString(),
      })),
    };
  }

  async analyses(q: AdminAnalysesQuery) {
    const where: Prisma.ListingAnalysisWhereInput = {
      ...(q.confidence ? { confidence: q.confidence } : {}),
      ...(q.minScore !== undefined ? { opportunityScore: { gte: q.minScore } } : {}),
      ...(q.engineVersion ? { engineVersion: q.engineVersion } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.listingAnalysis.count({ where }),
      this.prisma.listingAnalysis.findMany({
        where,
        include: { listing: { select: { title: true, make: true, model: true, year: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((a) => ({
        id: a.id,
        listingId: a.listingId,
        title: a.listing.title,
        make: a.listing.make,
        model: a.listing.model,
        year: a.listing.year,
        engineVersion: a.engineVersion,
        matchEvent: a.matchEvent,
        createdAt: a.createdAt.toISOString(),
        ...toAnalysisSummary(a),
      })),
    };
  }

  async analysis(id: number) {
    const a = await this.prisma.listingAnalysis.findUnique({
      where: { id },
      include: { listing: { select: { title: true, make: true, model: true, year: true } } },
    });
    if (!a) throw Errors.notFound();
    return {
      analysis: {
        id: a.id,
        listingId: a.listingId,
        title: a.listing.title,
        make: a.listing.make,
        model: a.listing.model,
        year: a.listing.year,
        engineVersion: a.engineVersion,
        expansionLevel: a.expansionLevel,
        matchEvent: a.matchEvent,
        listingPrice: a.listingPrice?.toString() ?? null,
        createdAt: a.createdAt.toISOString(),
        comparableIds: a.comparableIds,
        explanation: a.explanation as unknown,
        ...toAnalysisSummary(a),
      },
    };
  }

  /**
   * Sıra: ilan doğrula, Redis `SET NX EX 60` ile jobId'yi tut, kuyruğa ekle, ardından denetim kaydı (tx).
   * Denetim eklemeden SONRA yazılır: kuyruk hatasında (503) kayıt oluşmaz ve anahtar serbest bırakılır; iş yoksa
   * "yapıldı" denetimi de yoktur. Denetim yazımı başarısız olursa iş zaten kuyruktadır (yeniden analiz idempotenttir,
   * zararsız): anahtar bırakılır ve hata yayılır. Yinelenen istekler (60 sn) aynı jobId'yi alır, yeniden denetlenmez.
   */
  async reanalyze(ctx: AuditCtx, listingId: number): Promise<{ jobId: string }> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, status: true } });
    if (!listing) throw Errors.notFound();
    if (listing.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_OPERATION, 409, 'Kaldırılmış ilan yeniden analiz edilemez');

    const key = reanalyzeKey(listingId);
    const candidate = `analyze-manual-${listingId}-${Date.now()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let acquired: string | null;
      try {
        acquired = await this.redis.set(key, candidate, 'EX', REANALYZE_DEDUPE_SEC, 'NX');
      } catch {
        throw unavailable();
      }
      if (acquired === 'OK') return this.enqueue(ctx, listingId, key, candidate);
      const existing = await this.redis.get(key).catch(() => null);
      if (!existing) continue; // Anahtar arada süresi dolup silindi: yeniden dene
      // jobId bir arayüz ipucudur: iş tamamlanınca (removeOnComplete) ya da kuyruk temizlenince sorgulanamaz.
      // Anahtar kısa süreli yarış payından eskiyse ve iş yoksa yetim sayılır: sil ve yeniden dene.
      const job = await this.queues.analyze.getJob(existing).catch(() => undefined);
      if (job) return { jobId: existing };
      const ttl = await this.redis.ttl(key).catch(() => -1);
      if (ttl > 0 && REANALYZE_DEDUPE_SEC - ttl > PHANTOM_GRACE_SEC) {
        await this.redis.del(key).catch(() => undefined);
        continue;
      }
      return { jobId: existing };
    }
    throw unavailable();
  }

  /**
   * Denetim kaydı ve kuyruğa ekleme aynı transaction'da: ekleme başarısızsa tx geri alınır (denetim yok), anahtar silinir, 503.
   * Ekleme başarılı ama commit başarısızsa iş zaten kuyrukta: anahtar KORUNUR, 60 sn içindeki yeniden deneme aynı jobId'yi alır.
   */
  private async enqueue(ctx: AuditCtx, listingId: number, key: string, jobId: string): Promise<{ jobId: string }> {
    let added = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.audit.recordInTx(tx, ctx, { targetType: 'Listing', targetId: String(listingId), after: { jobId } });
        try {
          await this.queues.analyze.add('analyze', { listingId, reason: 'MANUAL' }, { jobId, ...RETRYING_JOB_OPTS });
        } catch {
          throw new EnqueueFailed();
        }
        added = true;
      });
    } catch (err) {
      if (!added) await this.redis.del(key).catch(() => undefined);
      if (err instanceof EnqueueFailed) throw unavailable();
      throw err;
    }
    return { jobId };
  }
}
