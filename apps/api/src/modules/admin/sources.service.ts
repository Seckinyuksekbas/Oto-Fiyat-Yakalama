import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DataSource, Prisma } from '@oto/db';
import { ADAPTER_KEYS, ErrorCode, maskUrlQuery, SCRAPE_JOB_OPTS, scrapeQueueJobId, type AdminSourceCreate, type AdminSourceUpdate } from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError, Errors } from '../../common/errors/app-error';
import { assertPublicHttpUrl } from '../../common/security/ssrf';
import { AdminQueues } from '../../infra/admin-queues.service';
import { PrismaService } from '../../infra/prisma.service';
import { boundLocks, LOCK_TX_OPTIONS } from '../../infra/tx-options';
import { RedisService } from '../../infra/redis.service';
import { ALLOW_PRIVATE_URLS } from './admin.tokens';
import { containsMaskedSecret, MaskedSecretMissingError, maskConfigSecrets, mergeMaskedConfig } from './config-mask';

export type StatsRange = '24h' | '7d' | '30d';
const RANGE_MS: Record<StatsRange, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export const TEST_SCRAPE_THROTTLE_SEC = 60;
export const testScrapeKey = (sourceId: number) => `test-scrape:${sourceId}`;
export { scrapeQueueJobId };

const conflict = (msg: string) => new AppError(ErrorCode.INVALID_OPERATION, 409, msg);
const badRequest = (msg: string) => new AppError(ErrorCode.VALIDATION_FAILED, 400, msg);
const BLOCK_PAUSED_MSG = 'Kaynak engel sinyali nedeniyle duraklatılmış; önce nedeni inceleyip etkinleştirin';

/** Anahtar sırasından bağımsız JSON eşitliği (jsonb anahtarları yeniden sıralar; sıra farkı değişiklik değildir). */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date)
      ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const istanbulDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

/**
 * Yanıt ve denetim kaydı (before/after) için config maskesi: gizli adlı anahtarlar (`config-mask.ts`) `"***"`,
 * `baseUrl`'in sorgu dizisi (olası token) `?…` olur.
 */
function maskConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const masked = maskConfigSecrets(config as Record<string, unknown>);
  return typeof masked.baseUrl === 'string' ? { ...masked, baseUrl: maskUrlQuery(masked.baseUrl) } : masked;
}

export function toSourceView(s: DataSource) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    adapterKey: s.adapterKey,
    kind: s.kind,
    permissionType: s.permissionType,
    permissionNote: s.permissionNote,
    permissionVerifiedAt: s.permissionVerifiedAt,
    isActive: s.isActive,
    intervalSec: s.intervalSec,
    maxConcurrency: s.maxConcurrency,
    minRequestGapMs: s.minRequestGapMs,
    config: maskConfig(s.config),
    proxyConfigId: s.proxyConfigId,
    health: s.health,
    lastSuccessAt: s.lastSuccessAt,
    lastErrorAt: s.lastErrorAt,
    consecutiveFailures: s.consecutiveFailures,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
type SourceView = ReturnType<typeof toSourceView>;

/** Denetim kaydı için (before/after) değişebilir alanlar */
const AUDIT_FIELDS = [
  'name', 'adapterKey', 'kind', 'permissionType', 'permissionNote', 'permissionVerifiedAt', 'isActive',
  'intervalSec', 'maxConcurrency', 'minRequestGapMs', 'config', 'proxyConfigId', 'health', 'consecutiveFailures',
] as const;
const snap = (s: SourceView): Record<string, unknown> => Object.fromEntries(AUDIT_FIELDS.map((k) => [k, s[k]]));

@Injectable()
export class AdminSourcesService {
  private readonly logger = new Logger(AdminSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly queues: AdminQueues,
    @Inject(ALLOW_PRIVATE_URLS) private readonly allowPrivate: boolean,
  ) {}

  private async requireSource(id: number): Promise<DataSource> {
    const s = await this.prisma.dataSource.findUnique({ where: { id } });
    if (!s) throw Errors.notFound();
    return s;
  }

  private async validateRefs(input: { adapterKey?: string; config?: { baseUrl: string }; proxyConfigId?: number | null }): Promise<void> {
    if (input.adapterKey !== undefined && !ADAPTER_KEYS.includes(input.adapterKey)) {
      throw badRequest(`Bilinmeyen adapter: ${input.adapterKey}`);
    }
    if (input.config) await assertPublicHttpUrl(input.config.baseUrl, { allowPrivate: this.allowPrivate });
    if (input.proxyConfigId != null && !(await this.prisma.proxyConfig.findUnique({ where: { id: input.proxyConfigId }, select: { id: true } }))) {
      throw badRequest('Proxy bulunamadı');
    }
  }

  async list() {
    const since = new Date(Date.now() - RANGE_MS['24h']);
    const recent = { dryRun: false, createdAt: { gte: since } };
    const [sources, jobs, sums] = await Promise.all([
      this.prisma.dataSource.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.collectionJob.groupBy({ by: ['sourceId', 'status'], where: recent, _count: { _all: true } }),
      this.prisma.collectionJob.groupBy({
        by: ['sourceId'],
        where: recent,
        _sum: { listingsNew: true, listingsUpdated: true, listingsRemoved: true },
      }),
    ]);
    const items = sources.map((s) => {
      const counts = { total: 0, succeeded: 0, failed: 0, partial: 0 };
      for (const j of jobs.filter((x) => x.sourceId === s.id)) {
        counts.total += j._count._all;
        if (j.status === 'SUCCEEDED') counts.succeeded += j._count._all;
        else if (j.status === 'FAILED') counts.failed += j._count._all;
        else if (j.status === 'PARTIAL') counts.partial += j._count._all;
      }
      const sum = sums.find((x) => x.sourceId === s.id)?._sum;
      return {
        ...toSourceView(s),
        last24h: { jobs: counts, listings: { new: sum?.listingsNew ?? 0, updated: sum?.listingsUpdated ?? 0, removed: sum?.listingsRemoved ?? 0 } },
      };
    });
    return { items, total: items.length };
  }

  async get(id: number) {
    return { source: toSourceView(await this.requireSource(id)) };
  }

  async create(ctx: AuditCtx, input: AdminSourceCreate) {
    // Oluşturmada saklı değer yok: gizli alanda "***" eşlenemez.
    if (containsMaskedSecret(input.config)) throw badRequest('Gizli config alanlarında *** kullanılamaz; gerçek değeri yazın');
    await this.validateRefs(input);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const s = await tx.dataSource.create({
          data: {
            code: input.code,
            name: input.name,
            adapterKey: input.adapterKey,
            kind: input.kind,
            permissionType: input.permissionType,
            permissionNote: input.permissionNote,
            permissionVerifiedAt: input.permissionVerified ? new Date() : null,
            isActive: false,
            intervalSec: input.intervalSec,
            maxConcurrency: input.maxConcurrency,
            minRequestGapMs: input.minRequestGapMs,
            config: input.config as Prisma.InputJsonValue,
            proxyConfigId: input.proxyConfigId,
          },
        });
        await this.audit.recordInTx(tx, ctx, { targetType: 'DataSource', targetId: String(s.id), before: null, after: { code: s.code, ...snap(toSourceView(s)) } });
        return s;
      });
      return { source: toSourceView(created) };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('Bu kaynak kodu zaten kullanılıyor');
      throw err;
    }
  }

  async update(ctx: AuditCtx, id: number, input: AdminSourceUpdate) {
    await this.requireSource(id);
    await this.validateRefs(input);
    return this.prisma.$transaction(async (tx) => {
      await boundLocks(tx);
      const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "DataSource" WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!locked) throw Errors.notFound();
      const before = await tx.dataSource.findUniqueOrThrow({ where: { id } });
      const { permissionVerified, ...rest } = input;
      if (rest.config) {
        // "***" gelen gizli alanlar saklı değeri korur; karşılığı yoksa 400.
        try {
          rest.config = mergeMaskedConfig(before.config, rest.config) as typeof rest.config;
        } catch (err) {
          if (err instanceof MaskedSecretMissingError) throw badRequest(err.message);
          throw err;
        }
        if (Buffer.byteLength(JSON.stringify(rest.config)) > 4096) throw badRequest('config 4 KB sınırını aşıyor');
      }
      const data: Prisma.DataSourceUncheckedUpdateInput = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v === undefined) continue;
        if (!sameJson((before as Record<string, unknown>)[k], v)) (data as Record<string, unknown>)[k] = v;
      }
      if (permissionVerified === true && !before.permissionVerifiedAt) data.permissionVerifiedAt = new Date();
      if (permissionVerified === false && before.permissionVerifiedAt) {
        // İzin geri alınırsa kaynak etkin kalamaz.
        data.permissionVerifiedAt = null;
        data.isActive = false;
      }
      if (Object.keys(data).length === 0) return { source: toSourceView(before) };
      const after = await tx.dataSource.update({ where: { id }, data });
      const b = snap(toSourceView(before));
      const a = snap(toSourceView(after));
      const keys = AUDIT_FIELDS.filter((k) => !sameJson((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k]));
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'DataSource',
        targetId: String(id),
        before: Object.fromEntries(keys.map((k) => [k, b[k]])),
        after: Object.fromEntries(keys.map((k) => [k, a[k]])),
      });
      return { source: toSourceView(after) };
    }, LOCK_TX_OPTIONS);
  }

  async activate(ctx: AuditCtx, id: number) {
    return this.prisma.$transaction(async (tx) => {
      await boundLocks(tx);
      const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "DataSource" WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!locked) throw Errors.notFound();
      const before = await tx.dataSource.findUniqueOrThrow({ where: { id } });
      if (!before.permissionVerifiedAt) throw conflict('İzin doğrulanmadan kaynak etkinleştirilemez');
      if (before.isActive && before.health !== 'PAUSED') return { source: toSourceView(before) };
      const after = await tx.dataSource.update({
        where: { id },
        data: { isActive: true, ...(before.health === 'PAUSED' ? { health: 'HEALTHY' as const, consecutiveFailures: 0 } : {}) },
      });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'DataSource',
        targetId: String(id),
        before: { isActive: before.isActive, health: before.health, consecutiveFailures: before.consecutiveFailures },
        after: { isActive: after.isActive, health: after.health, consecutiveFailures: after.consecutiveFailures },
      });
      return { source: toSourceView(after) };
    }, LOCK_TX_OPTIONS);
  }

  async pause(ctx: AuditCtx, id: number) {
    return this.prisma.$transaction(async (tx) => {
      await boundLocks(tx);
      const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "DataSource" WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!locked) throw Errors.notFound();
      const before = await tx.dataSource.findUniqueOrThrow({ where: { id } });
      // Yönetici duraklatması yalnızca zamanlamayı kapatır; sağlık (engel kaynaklı PAUSED dahil) olduğu gibi kalır.
      if (!before.isActive) return { source: toSourceView(before) };
      const after = await tx.dataSource.update({ where: { id }, data: { isActive: false } });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'DataSource',
        targetId: String(id),
        before: { isActive: before.isActive, health: before.health },
        after: { isActive: after.isActive, health: after.health },
      });
      return { source: toSourceView(after) };
    }, LOCK_TX_OPTIONS);
  }

  /** Test taraması: kaynak başına dakikada 1 (Redis SET NX EX); aynı anda bekleyen/çalışan iş varsa 409. */
  async testScrape(ctx: AuditCtx, id: number, dryRun: boolean): Promise<{ jobId: number }> {
    const source = await this.requireSource(id);
    if (!source.permissionVerifiedAt) throw conflict('İzin doğrulanmadan test taraması yapılamaz');
    if (!ADAPTER_KEYS.includes(source.adapterKey)) throw conflict(`Bilinmeyen adapter: ${source.adapterKey}`);
    // Engel sinyali (health=PAUSED): dry-run bile olsa kaynağa istek atılmaz (önce neden incelenip etkinleştirilmeli).
    // Yönetici duraklatması (yalnız isActive=false) dry-run'ı engellemez.
    if (source.health === 'PAUSED') throw conflict(BLOCK_PAUSED_MSG);
    // Gerçek (kayıt yazan) tarama yalnızca etkin kaynakta; etkin olmayan kaynakta yalnızca dry-run.
    if (!dryRun && !source.isActive) throw conflict('Etkin olmayan kaynakta yalnızca dry-run test taraması yapılabilir');
    const key = testScrapeKey(id);
    const acquired = await this.redis.set(key, '1', 'EX', TEST_SCRAPE_THROTTLE_SEC, 'NX');
    if (acquired !== 'OK') throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Bu kaynak için dakikada en fazla 1 test taraması başlatılabilir');
    let jobId: number;
    try {
      jobId = await this.prisma.$transaction(async (tx) => {
        await boundLocks(tx);
        // Zamanlayıcı da aynı satır kilidini alır: iş oluşturma sıralanır.
        const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "DataSource" WHERE id = ${id} FOR NO KEY UPDATE`;
        if (!locked) throw Errors.notFound();
        const fresh = await tx.dataSource.findUniqueOrThrow({ where: { id }, select: { isActive: true, health: true } });
        if (fresh.health === 'PAUSED') throw conflict(BLOCK_PAUSED_MSG);
        if (!dryRun && !fresh.isActive) throw conflict('Etkin olmayan kaynakta yalnızca dry-run test taraması yapılabilir');
        const busy = await tx.collectionJob.findFirst({ where: { sourceId: id, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
        if (busy) throw conflict('Bu kaynak için devam eden bir iş var');
        const job = await tx.collectionJob.create({ data: { sourceId: id, trigger: 'MANUAL', dryRun } });
        await this.audit.recordInTx(tx, ctx, { targetType: 'DataSource', targetId: String(id), before: null, after: { jobId: job.id, dryRun } });
        return job.id;
      }, LOCK_TX_OPTIONS);
    } catch (err) {
      await this.redis.del(key).catch(() => undefined);
      throw err;
    }
    try {
      await this.queues.scrape.add(
        'scrape',
        { collectionJobId: jobId, sourceId: id },
        { jobId: scrapeQueueJobId(jobId), ...SCRAPE_JOB_OPTS },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Test taraması kuyruğa eklenemedi (kaynak ${id}): ${message}`);
      await this.prisma.collectionJob.updateMany({
        where: { id: jobId, status: 'QUEUED' },
        data: { status: 'FAILED', finishedAt: new Date(), errorSummary: 'Kuyruğa eklenemedi' },
      });
      await this.redis.del(key).catch(() => undefined);
      throw new AppError(ErrorCode.INTERNAL, 503, 'İş kuyruğuna eklenemedi');
    }
    return { jobId };
  }

  async stats(id: number, range: StatsRange) {
    await this.requireSource(id);
    const since = new Date(Date.now() - RANGE_MS[range]);
    const [jobs, errors] = await Promise.all([
      this.prisma.collectionJob.findMany({
        where: { sourceId: id, dryRun: false, createdAt: { gte: since } },
        select: { status: true, createdAt: true, avgResponseMs: true, listingsNew: true, listingsUpdated: true, listingsRemoved: true },
      }),
      this.prisma.scrapeError.groupBy({ by: ['kind'], where: { sourceId: id, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const counts = { total: jobs.length, succeeded: 0, failed: 0, partial: 0 };
    const perDay = new Map<string, { day: string; new: number; updated: number; removed: number }>();
    const ms: number[] = [];
    for (const j of jobs) {
      if (j.status === 'SUCCEEDED') counts.succeeded += 1;
      else if (j.status === 'FAILED') counts.failed += 1;
      else if (j.status === 'PARTIAL') counts.partial += 1;
      if (j.avgResponseMs != null) ms.push(j.avgResponseMs);
      const day = istanbulDay(j.createdAt);
      const row = perDay.get(day) ?? { day, new: 0, updated: 0, removed: 0 };
      row.new += j.listingsNew;
      row.updated += j.listingsUpdated;
      row.removed += j.listingsRemoved;
      perDay.set(day, row);
    }
    const finished = counts.succeeded + counts.failed + counts.partial;
    return {
      jobs: counts,
      listingsPerDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      errorRate: finished === 0 ? 0 : (counts.failed + counts.partial) / finished,
      avgResponseMs: ms.length === 0 ? null : Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
      errorsByKind: Object.fromEntries(errors.map((e) => [e.kind, e._count._all])),
    };
  }
}
