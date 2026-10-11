import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import { MATCH_DISPATCH_MAX_ATTEMPTS, matchDispatchStuckFlagKey, type AdminStuckDispatchesQuery } from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';

/** Worker analiz süpürmesiyle aynı tanım: olay var, kuyruğa alınmamış ve deneme sınırına ulaşmış. */
const STUCK: Prisma.ListingAnalysisWhereInput = {
  matchEvent: { in: ['NEW', 'PRICE_DROP', 'RELIST'] },
  matchQueuedAt: null,
  matchDispatchAttempts: { gte: MATCH_DISPATCH_MAX_ATTEMPTS },
};

@Injectable()
export class AdminMatchDispatchesService {
  private readonly logger = new Logger(AdminMatchDispatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async stuck(q: AdminStuckDispatchesQuery) {
    const [total, rows] = await Promise.all([
      this.prisma.listingAnalysis.count({ where: STUCK }),
      this.prisma.listingAnalysis.findMany({
        where: STUCK,
        include: { listing: { select: { title: true, make: true, model: true, year: true, status: true } } },
        orderBy: { id: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((a) => ({
        analysisId: a.id,
        listingId: a.listingId,
        matchEvent: a.matchEvent,
        matchDispatchAttempts: a.matchDispatchAttempts,
        createdAt: a.createdAt.toISOString(),
        listing: a.listing,
      })),
    };
  }

  /**
   * Sayaç 0'a çekilir; scheduler bir sonraki süpürmede olayı yeniden gönderir. Koşullu `updateMany` (hâlâ takılı mı)
   * eşzamanlı ikinci isteği no-op yapar (denetim tek kayıt). Takılı olmayan satır: değişiklik yok, mevcut sayaç döner.
   * Commit sonrası "bir kez alarm" işareti silinir ki satır yeniden takılırsa alarm tekrar verilsin.
   */
  async reset(ctx: AuditCtx, analysisId: number): Promise<{ analysisId: number; matchDispatchAttempts: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.listingAnalysis.findUnique({ where: { id: analysisId }, select: { matchDispatchAttempts: true } });
      if (!row) throw Errors.notFound();
      const upd = await tx.listingAnalysis.updateMany({ where: { id: analysisId, ...STUCK }, data: { matchDispatchAttempts: 0 } });
      if (upd.count === 0) {
        const now = await tx.listingAnalysis.findUniqueOrThrow({ where: { id: analysisId }, select: { matchDispatchAttempts: true } });
        return { changed: false, attempts: now.matchDispatchAttempts };
      }
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'ListingAnalysis',
        targetId: String(analysisId),
        before: { matchDispatchAttempts: row.matchDispatchAttempts },
        after: { matchDispatchAttempts: 0 },
      });
      return { changed: true, attempts: 0 };
    });
    if (result.changed) {
      await this.redis.del(matchDispatchStuckFlagKey(analysisId)).catch((err: unknown) => {
        this.logger.warn(`Takılı eşleştirme alarm işareti silinemedi (analiz ${analysisId}): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return { analysisId, matchDispatchAttempts: result.attempts };
  }
}
