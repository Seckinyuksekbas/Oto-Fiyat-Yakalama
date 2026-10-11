import { Injectable } from '@nestjs/common';
import type { CollectionJob, Prisma } from '@oto/db';
import { maskUrlQuery, type AdminJobsQuery } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { maskUrlsInText } from './url-mask';

type JobWithSource = CollectionJob & { source: { code: string; name: string } };

function toJobView(j: JobWithSource) {
  return {
    id: j.id,
    sourceId: j.sourceId,
    sourceCode: j.source.code,
    sourceName: j.source.name,
    trigger: j.trigger,
    dryRun: j.dryRun,
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    pagesFetched: j.pagesFetched,
    listingsSeen: j.listingsSeen,
    listingsNew: j.listingsNew,
    listingsUpdated: j.listingsUpdated,
    listingsRemoved: j.listingsRemoved,
    errorsCount: j.errorsCount,
    avgResponseMs: j.avgResponseMs,
    errorSummary: maskUrlsInText(j.errorSummary),
    createdAt: j.createdAt,
  };
}

const URL_KEY = /(^url$|Url$|Urls$)/;

function maskUrlFields(obj: Record<string, Prisma.JsonValue>): Record<string, Prisma.JsonValue> {
  const out: Record<string, Prisma.JsonValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (URL_KEY.test(k) && typeof v === 'string') out[k] = maskUrlQuery(v);
    else if (URL_KEY.test(k) && Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? maskUrlQuery(x) : x));
    else out[k] = v;
  }
  return out;
}

/** Dry-run sonucunda ilanların URL alanlarını (url, *Url, *Urls) ve sorun ham parçalarındaki URL'leri maskeler. */
function maskDryRunResult(value: Prisma.JsonValue | null): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const r = value as Record<string, Prisma.JsonValue>;
  const isObj = (x: Prisma.JsonValue): x is Record<string, Prisma.JsonValue> => !!x && typeof x === 'object' && !Array.isArray(x);
  const items = Array.isArray(r.items) ? r.items.map((it) => (isObj(it) ? maskUrlFields(it) : it)) : r.items;
  const problems = Array.isArray(r.problems)
    ? r.problems.map((p) => (isObj(p) ? { ...p, ...(typeof p.rawSnippet === 'string' ? { rawSnippet: maskUrlsInText(p.rawSnippet) } : {}), ...(typeof p.problem === 'string' ? { problem: maskUrlsInText(p.problem) } : {}) } : p))
    : r.problems;
  return { ...r, items: items ?? null, problems: problems ?? null };
}

@Injectable()
export class AdminJobsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: AdminJobsQuery) {
    const where: Prisma.CollectionJobWhereInput = {
      ...(q.source ? { sourceId: q.source } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.trigger ? { trigger: q.trigger } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.collectionJob.count({ where }),
      this.prisma.collectionJob.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { source: { select: { code: true, name: true } } },
      }),
    ]);
    return { total, items: rows.map(toJobView) };
  }

  async get(id: number) {
    const j = await this.prisma.collectionJob.findUnique({
      where: { id },
      include: { source: { select: { code: true, name: true } }, errors: { orderBy: { id: 'asc' }, take: 100 } },
    });
    if (!j) throw Errors.notFound();
    return {
      job: {
        ...toJobView(j),
        dryRunResult: maskDryRunResult(j.dryRunResult),
        errors: j.errors.map((e) => ({
          id: e.id,
          kind: e.kind,
          url: e.url ? maskUrlQuery(e.url) : null,
          message: maskUrlsInText(e.message),
          transient: e.transient,
          createdAt: e.createdAt,
        })),
      },
    };
  }
}
