import { Inject, Injectable, Logger } from '@nestjs/common';
import { FetchError, getAdapter, LayoutError, normalizeListing, PoliteHttpClient, type ListingProblem, type SourceAdapter } from '@oto/collection';
import type { JobStatus, Prisma } from '@oto/db';
import { Encryptor } from '@oto/server-common';
import { AlertService } from '../common/alert.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { AliasService } from './alias.service';
import { IngestService } from './ingest.service';
import { PARSE_ISSUE_THRESHOLD, SourceHealthService } from './source-health.service';

export interface RunSummary {
  status: JobStatus;
  pages: number;
  cards: number;
  created: number;
  updated: number;
  removed: number;
  failed: number;
}

class InfraError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Tek taramada kaybolan ilan sayısı bu eşiği (en az MIN, ya da aktiflerin ORAN'ı) aşarsa toplu kaldırma atlanır. */
export const MASS_REMOVAL_MIN = 20;
export const MASS_REMOVAL_RATIO = 0.3;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

@Injectable()
export class ScrapeRunner {
  private readonly logger = new Logger(ScrapeRunner.name);
  private readonly userAgent: string;
  private readonly blockPrivateAddresses: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly encryptor: Encryptor,
    private readonly aliases: AliasService,
    private readonly ingest: IngestService,
    private readonly health: SourceHealthService,
    private readonly alerts: AlertService,
    @Inject(ENV) env: Env,
  ) {
    this.userAgent = `OtoFirsatBot/1.0 (+${env.BOT_CONTACT_URL})`;
    this.blockPrivateAddresses = env.NODE_ENV === 'production';
  }

  /** İşi yalnızca hâlâ RUNNING ise kapatır; stale-reaper zaten kapattıysa üzerine yazmaz. */
  private async closeJob(id: number, data: Prisma.CollectionJobUpdateManyMutationInput): Promise<void> {
    const { count } = await this.prisma.collectionJob.updateMany({ where: { id, status: 'RUNNING' }, data });
    if (count === 0) this.logger.warn(`İş zaten kapatılmış (stale?): ${id}`);
  }

  /** Bir CollectionJob'u uçtan uca yürütür. Yalnızca QUEUED işleri çalıştırır (yeniden teslimde güvenli). */
  async run(collectionJobId: number): Promise<RunSummary | null> {
    const job = await this.prisma.collectionJob.findUnique({
      where: { id: collectionJobId },
      include: { source: { include: { proxyConfig: true } } },
    });
    if (!job || job.status !== 'QUEUED') return null;
    const { source } = job;

    const refuse = async (reason: string) => {
      await this.prisma.collectionJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), errorSummary: reason } });
      return null;
    };
    if (job.dryRun) return refuse('Dry-run henüz desteklenmiyor (Plan 07)');
    if (!source.isActive || !source.permissionVerifiedAt || source.health === 'PAUSED') {
      return refuse('Kaynak pasif, izinsiz veya duraklatılmış');
    }
    let adapter: SourceAdapter;
    try {
      adapter = getAdapter(source.adapterKey);
    } catch (err) {
      return refuse(message(err));
    }

    const startedAt = new Date();
    const claimed = await this.prisma.collectionJob.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt } });
    if (claimed.count !== 1) return null;

    let http: PoliteHttpClient | null = null;
    let resolve: Awaited<ReturnType<AliasService['resolver']>>;
    try {
      http = new PoliteHttpClient({
        sourceId: source.id,
        minRequestGapMs: source.minRequestGapMs,
        userAgent: this.userAgent,
        blockPrivateAddresses: this.blockPrivateAddresses,
        redis: this.redis,
        proxyUrl: source.proxyConfig?.isEnabled ? this.encryptor.decrypt(source.proxyConfig.urlEncrypted) : null,
        isBlockedPage: adapter.isBlockedPage ? (html) => adapter.isBlockedPage!(html) : undefined,
      });
      resolve = await this.aliases.resolver();
    } catch (err) {
      await http?.close().catch(() => undefined);
      const reason = `Kurulum hatası: ${message(err)}`.slice(0, 500);
      this.logger.error(`Kaynak ${source.code} için ${reason}`);
      await this.closeJob(job.id, { status: 'FAILED', finishedAt: new Date(), errorSummary: reason });
      return { status: 'FAILED', pages: 0, cards: 0, created: 0, updated: 0, removed: 0, failed: 0 };
    }

    const c = { pages: 0, cards: 0, created: 0, updated: 0, removed: 0, failed: 0, complete: false };
    let fatal: unknown = null;
    let infra: unknown = null;
    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        throw new InfraError(err);
      }
    };

    try {
      for await (const page of adapter.listPages({ http, config: source.config })) {
        c.pages += 1;
        const parsed = adapter.parseList(page);
        const problems: ListingProblem[] = [...parsed.problems];
        c.cards += parsed.listings.length + parsed.problems.length;
        c.failed += parsed.problems.length;
        for (const raw of parsed.listings) {
          const normalized = normalizeListing(raw, resolve);
          if (!normalized.ok) {
            c.failed += 1;
            problems.push(...normalized.problems);
            continue;
          }
          const { outcome } = await guard(() => this.ingest.ingest(source.id, normalized.listing, startedAt));
          if (outcome === 'NEW') c.created += 1;
          else if (outcome !== 'UNCHANGED') c.updated += 1;
        }
        await guard(() => this.ingest.recordProblems(source.id, problems));
        const seenInvalid = [...new Set(problems.map((p) => p.externalId).filter((id): id is string => !!id))];
        await guard(() => this.ingest.touchSeen(source.id, seenInvalid, startedAt));
        if (page.isLast) c.complete = true;
      }
    } catch (err) {
      if (err instanceof InfraError) infra = err.cause;
      else fatal = err;
    } finally {
      await http.close();
    }

    if (infra) {
      const reason = `Altyapı hatası: ${message(infra)}`.slice(0, 500);
      this.logger.error(`Kaynak ${source.code} taraması altyapı hatasıyla durdu: ${message(infra)}`);
      await this.closeJob(job.id, { status: 'FAILED', finishedAt: new Date(), pagesFetched: c.pages, listingsSeen: c.cards, listingsNew: c.created, listingsUpdated: c.updated, errorsCount: c.failed, errorSummary: reason })
        .catch((e: unknown) => this.logger.error(`İş durumu güncellenemedi: ${message(e)}`));
      throw infra;
    }

    const issueRate = c.cards === 0 ? (c.pages > 0 ? 1 : 0) : c.failed / c.cards;
    let status: JobStatus;
    let errorSummary: string | null;
    try {
      if (fatal) {
        const fe = fatal instanceof FetchError ? fatal : null;
        await this.prisma.scrapeError.create({
          data: { jobId: job.id, sourceId: source.id, kind: fe?.kind ?? 'PARSE', url: fe?.url ?? null, message: message(fatal).slice(0, 1000), transient: fe?.transient ?? false },
        });
        if (fatal instanceof LayoutError) await this.health.recordLayoutBreak(source.id, fatal);
        else await this.health.recordFailure(source.id, fatal instanceof Error ? fatal : new Error(message(fatal)));
        status = c.pages > 0 && fe?.kind !== 'BLOCKED' ? 'PARTIAL' : 'FAILED';
        errorSummary = message(fatal).slice(0, 500);
        this.logger.warn(`Kaynak ${source.code} taraması başarısız: ${message(fatal)}`);
      } else {
        const fullCrawl = (source.config as { fullCrawl?: boolean } | null)?.fullCrawl !== false;
        const notes: string[] = [];
        if (fullCrawl && c.complete && c.cards > 0 && issueRate <= PARSE_ISSUE_THRESHOLD) {
          const candidates = await this.ingest.countRemovalCandidates(source.id, startedAt);
          const active = await this.ingest.countActive(source.id);
          if (candidates > Math.max(MASS_REMOVAL_MIN, Math.ceil(MASS_REMOVAL_RATIO * active))) {
            const note = `${candidates} ilan tek taramada kayboldu; toplu kaldırma güvenlik nedeniyle atlandı.`;
            notes.push(note);
            await this.alerts.raise({
              key: `source:${source.id}:mass-removal`,
              level: 'WARN',
              component: 'collection',
              message: `${source.name}: ${note}`,
              context: { sourceId: source.id, candidates, active },
            });
          } else if (candidates > 0) {
            c.removed = await this.ingest.markRemoved(source.id, startedAt);
          }
        }
        if (!c.complete && c.pages > 0) notes.push('Tarama sayfa sınırında durdu; kaldırma tespiti atlandı');
        await this.health.recordSuccess(source.id, issueRate);
        const empty = c.pages > 0 && c.cards === 0;
        status = c.failed > 0 || empty ? 'PARTIAL' : 'SUCCEEDED';
        if (empty) notes.unshift('Sayfada ilan kartı bulunamadı');
        else if (c.failed > 0) notes.unshift(`${c.failed} ilan ayrıştırılamadı veya doğrulanamadı`);
        errorSummary = notes.length > 0 ? notes.join('; ').slice(0, 500) : null;
      }

      await this.closeJob(job.id, {
          status,
          finishedAt: new Date(),
          pagesFetched: c.pages,
          listingsSeen: c.cards,
          listingsNew: c.created,
          listingsUpdated: c.updated,
          listingsRemoved: c.removed,
          errorsCount: c.failed + (fatal ? 1 : 0),
          avgResponseMs: http.stats.requests > 0 ? Math.round(http.stats.totalMs / http.stats.requests) : null,
          errorSummary,
      });
    } catch (err) {
      this.logger.error(`Kaynak ${source.code} sonuç kaydı başarısız: ${message(err)}`);
      await this.closeJob(job.id, { status: 'FAILED', finishedAt: new Date(), errorSummary: `Altyapı hatası: ${message(err)}`.slice(0, 500) })
        .catch((e: unknown) => this.logger.error(`İş durumu güncellenemedi: ${message(e)}`));
      throw err;
    }
    if (status === 'SUCCEEDED') {
      try {
        const n = await this.ingest.enqueuePostScrapeAnalysis(source.id, startedAt, job.id);
        if (n > 0) this.logger.log(`Kaynak ${source.code}: ${n} yeni/yetersiz ilan için tarama sonrası yeniden analiz kuyruğa alındı`);
      } catch (err) {
        this.logger.warn(`Kaynak ${source.code} tarama sonrası yeniden analiz kuyruğa alınamadı: ${message(err)}`);
      }
    }
    return { status, pages: c.pages, cards: c.cards, created: c.created, updated: c.updated, removed: c.removed, failed: c.failed };
  }
}
