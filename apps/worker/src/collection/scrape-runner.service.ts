import { Inject, Injectable, Logger } from '@nestjs/common';
import { FetchError, getAdapter, normalizeListing, PoliteHttpClient, type ListingProblem, type SourceAdapter } from '@oto/collection';
import type { JobStatus } from '@oto/db';
import { Encryptor } from '@oto/server-common';
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

@Injectable()
export class ScrapeRunner {
  private readonly logger = new Logger(ScrapeRunner.name);
  private readonly userAgent: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly encryptor: Encryptor,
    private readonly aliases: AliasService,
    private readonly ingest: IngestService,
    private readonly health: SourceHealthService,
    @Inject(ENV) env: Env,
  ) {
    this.userAgent = `OtoFirsatBot/1.0 (+${env.BOT_CONTACT_URL})`;
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
    await this.prisma.collectionJob.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt } });

    const http = new PoliteHttpClient({
      sourceId: source.id,
      minRequestGapMs: source.minRequestGapMs,
      userAgent: this.userAgent,
      redis: this.redis,
      proxyUrl: source.proxyConfig?.isEnabled ? this.encryptor.decrypt(source.proxyConfig.urlEncrypted) : null,
      isBlockedPage: adapter.isBlockedPage ? (html) => adapter.isBlockedPage!(html) : undefined,
    });
    const resolve = await this.aliases.resolver();
    const c = { pages: 0, cards: 0, created: 0, updated: 0, removed: 0, failed: 0, complete: false };
    let fatal: unknown = null;

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
          const { outcome } = await this.ingest.ingest(source.id, normalized.listing, startedAt);
          if (outcome === 'NEW') c.created += 1;
          else if (outcome !== 'UNCHANGED') c.updated += 1;
        }
        await this.ingest.recordProblems(source.id, problems);
        if (page.isLast) c.complete = true;
      }
    } catch (err) {
      fatal = err;
    } finally {
      await http.close();
    }

    const issueRate = c.cards === 0 ? (c.pages > 0 ? 1 : 0) : c.failed / c.cards;
    let status: JobStatus;
    if (fatal) {
      const fe = fatal instanceof FetchError ? fatal : null;
      await this.prisma.scrapeError.create({
        data: { jobId: job.id, sourceId: source.id, kind: fe?.kind ?? 'PARSE', url: fe?.url ?? null, message: message(fatal).slice(0, 1000), transient: fe?.transient ?? false },
      });
      await this.health.recordFailure(source.id, fatal instanceof Error ? fatal : new Error(message(fatal)));
      status = c.pages > 0 && fe?.kind !== 'BLOCKED' ? 'PARTIAL' : 'FAILED';
      this.logger.warn(`Kaynak ${source.code} taraması başarısız: ${message(fatal)}`);
    } else {
      const fullCrawl = (source.config as { fullCrawl?: boolean } | null)?.fullCrawl !== false;
      if (fullCrawl && c.complete && c.cards > 0 && issueRate <= PARSE_ISSUE_THRESHOLD) {
        c.removed = await this.ingest.markRemoved(source.id, startedAt);
      }
      await this.health.recordSuccess(source.id, issueRate);
      status = c.failed > 0 ? 'PARTIAL' : 'SUCCEEDED';
    }

    await this.prisma.collectionJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        pagesFetched: c.pages,
        listingsSeen: c.cards,
        listingsNew: c.created,
        listingsUpdated: c.updated,
        listingsRemoved: c.removed,
        errorsCount: c.failed + (fatal ? 1 : 0),
        avgResponseMs: http.stats.requests > 0 ? Math.round(http.stats.totalMs / http.stats.requests) : null,
        errorSummary: fatal ? message(fatal).slice(0, 500) : c.failed > 0 ? `${c.failed} ilan ayrıştırılamadı veya doğrulanamadı` : null,
      },
    });
    return { status, pages: c.pages, cards: c.cards, created: c.created, updated: c.updated, removed: c.removed, failed: c.failed };
  }
}
