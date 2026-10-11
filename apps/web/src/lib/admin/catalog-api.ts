import type { AdminSourceUpdate, AnalysisSummary, ListingCard } from '@oto/shared';
import { ApiError } from '../api';
import { adminErrorMessage, adminGet, adminSend, type PageQuery, type Paged } from '../admin-api';

/**
 * Task 11 admin uçları: ilanlar, sorunlu kayıtlar, analizler, kaynaklar (test taraması), işler, proxy'ler.
 * Tipler API servislerinin (`apps/api/src/modules/admin/{listings,sources,jobs,proxies}.service.ts`) gerçek
 * yanıtlarından türetilmiştir. Paylaşılan `admin-api.ts` yerine burada tutulur (Task 12 ile çakışmasın).
 */

const enc = (id: number | string) => encodeURIComponent(String(id));

// ---------------------------------------------------------------- ilanlar

export type ListingStatus = 'ACTIVE' | 'REMOVED';
export type Confidence = AnalysisSummary['confidence'];
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL';
export type JobTrigger = 'SCHEDULED' | 'MANUAL';

export interface AdminListingRow extends ListingCard {
  sourceId: number;
  sourceCode: string;
  issueCount: number;
}

export interface AdminListingsQuery extends PageQuery {
  source?: number;
  make?: string;
  model?: string;
  status?: ListingStatus;
  hasIssues?: 'true' | 'false';
  q?: string;
}

export interface AdminListingIssue {
  id: number;
  field: string;
  problem: string;
  externalId: string | null;
  rawSnippet: string | null;
  createdAt: string;
}

export interface AdminListingAnalysisEntry extends AnalysisSummary {
  id: number;
  createdAt: string;
  engineVersion: string;
  matchEvent: string | null;
  listingPrice: string | null;
}

export interface AdminListingDetail {
  listing: ListingCard & {
    sourceId: number;
    sourceCode: string;
    externalId: string;
    bodyType: string | null;
    color: string | null;
    sellerType: string | null;
    damageInfo: unknown;
    currency: string;
    lastSeenAt: string;
    removedAt: string | null;
    relistedAt: string | null;
    latestAnalysisId: number | null;
    matchCount: number;
  };
  analyses: AdminListingAnalysisEntry[];
  priceHistory: Array<{ price: string; km: number; observedAt: string }>;
  issues: AdminListingIssue[];
}

export interface AdminIssueRow extends AdminListingIssue {
  sourceId: number;
  sourceCode: string;
  listingId: number | null;
}

export interface AdminIssuesQuery extends PageQuery {
  source?: number;
  field?: string;
}

export interface AdminAnalysisRow extends AnalysisSummary {
  id: number;
  listingId: number;
  title: string;
  make: string;
  model: string;
  year: number;
  engineVersion: string;
  matchEvent: string | null;
  createdAt: string;
}

export interface AdminAnalysesQuery extends PageQuery {
  confidence?: Confidence;
  minScore?: number;
  engineVersion?: string;
}

export interface AdminAnalysisDetail {
  analysis: AdminAnalysisRow & {
    expansionLevel: number | null;
    listingPrice: string | null;
    comparableIds: number[];
    explanation: unknown;
  };
}

// ---------------------------------------------------------------- kaynaklar

export type SourceHealth = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'PAUSED';
export type PermissionType = 'LICENSED_API' | 'PARTNER_FEED' | 'TOS_PERMITTED' | 'TEST';
export type SourceKind = 'HTTP' | 'BROWSER' | 'API' | 'FEED';

export interface AdminSource {
  id: number;
  code: string;
  name: string;
  adapterKey: string;
  kind: SourceKind;
  permissionType: PermissionType;
  permissionNote: string | null;
  permissionVerifiedAt: string | null;
  isActive: boolean;
  intervalSec: number;
  maxConcurrency: number;
  minRequestGapMs: number;
  /** `baseUrl` sorgu dizisi yanıtta `?…` ile maskelidir. */
  config: unknown;
  proxyConfigId: number | null;
  health: SourceHealth;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSourceRow extends AdminSource {
  last24h: {
    jobs: { total: number; succeeded: number; failed: number; partial: number };
    listings: { new: number; updated: number; removed: number };
  };
}

export type StatsRange = '24h' | '7d' | '30d';

export interface AdminSourceStats {
  jobs: { total: number; succeeded: number; failed: number; partial: number };
  listingsPerDay: Array<{ day: string; new: number; updated: number; removed: number }>;
  errorRate: number;
  avgResponseMs: number | null;
  errorsByKind: Record<string, number>;
}

// ---------------------------------------------------------------- işler

export interface AdminJobRow {
  id: number;
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  trigger: JobTrigger;
  dryRun: boolean;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  pagesFetched: number;
  listingsSeen: number;
  listingsNew: number;
  listingsUpdated: number;
  listingsRemoved: number;
  errorsCount: number;
  avgResponseMs: number | null;
  errorSummary: string | null;
  createdAt: string;
}

export interface AdminJobsQuery extends PageQuery {
  source?: number;
  status?: JobStatus;
  trigger?: JobTrigger;
}

/** Worker dry-run çıktısı: ilk 20 normalize ilan (fiyat dizge) + sorunlar; URL'ler API'de maskelenir. */
export interface DryRunResult {
  pages: number;
  items: Array<Record<string, unknown>>;
  problems: Array<{ externalId?: string; field: string; problem: string; rawSnippet?: string }>;
  durationMs: number;
}

export interface AdminJobDetail {
  job: AdminJobRow & {
    dryRunResult: unknown;
    errors: Array<{ id: number; kind: string; url: string | null; message: string; transient: boolean; createdAt: string }>;
  };
}

export function isTerminalJob(status: JobStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'PARTIAL';
}

/** `dryRunResult` sunucuda `unknown`; alanlar savunmacı okunur. */
export function parseDryRun(input: unknown): DryRunResult | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  return {
    pages: typeof r.pages === 'number' ? r.pages : 0,
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
    items: Array.isArray(r.items) ? r.items.filter(isObj) : [],
    problems: Array.isArray(r.problems)
      ? r.problems.filter(isObj).map((p) => ({
          field: typeof p.field === 'string' ? p.field : '?',
          problem: typeof p.problem === 'string' ? p.problem : '',
          ...(typeof p.externalId === 'string' ? { externalId: p.externalId } : {}),
          ...(typeof p.rawSnippet === 'string' ? { rawSnippet: p.rawSnippet } : {}),
        }))
      : [],
  };
}

// ---------------------------------------------------------------- proxy'ler

export interface AdminProxy {
  id: number;
  name: string;
  /** Her zaman maskeli: `http://***@host:port`. */
  url: string;
  isEnabled: boolean;
  lastCheckAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  sourceCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** Proxy oluşturma/düzenleme gövdesi. `url` yalnızca gönderim anında taşınır; istemci önbelleğine ya da duruma yazılmaz. */
export interface ProxyWrite {
  name?: string;
  url?: string;
  isEnabled?: boolean;
}

// ---------------------------------------------------------------- uçlar

export const catalogApi = {
  listings: {
    list: (q: AdminListingsQuery) => adminGet<Paged<AdminListingRow>>('/listings', q),
    get: (id: number) => adminGet<AdminListingDetail>(`/listings/${enc(id)}`),
    reanalyze: (id: number) => adminSend<{ jobId: string }>('POST', `/listings/${enc(id)}/reanalyze`),
    issues: (q: AdminIssuesQuery) => adminGet<Paged<AdminIssueRow>>('/listing-issues', q),
  },
  analyses: {
    list: (q: AdminAnalysesQuery) => adminGet<Paged<AdminAnalysisRow>>('/analyses', q),
    get: (id: number) => adminGet<AdminAnalysisDetail>(`/analyses/${enc(id)}`),
  },
  sources: {
    list: () => adminGet<Paged<AdminSourceRow>>('/sources'),
    get: (id: number) => adminGet<{ source: AdminSource }>(`/sources/${enc(id)}`),
    update: (id: number, body: AdminSourceUpdate) => adminSend<{ source: AdminSource }>('PATCH', `/sources/${enc(id)}`, body),
    activate: (id: number) => adminSend<{ source: AdminSource }>('POST', `/sources/${enc(id)}/activate`),
    pause: (id: number) => adminSend<{ source: AdminSource }>('POST', `/sources/${enc(id)}/pause`),
    testScrape: (id: number) => adminSend<{ jobId: number }>('POST', `/sources/${enc(id)}/test-scrape`, { dryRun: true }),
    stats: (id: number, range: StatsRange) => adminGet<AdminSourceStats>(`/sources/${enc(id)}/stats`, { range }),
  },
  jobs: {
    list: (q: AdminJobsQuery) => adminGet<Paged<AdminJobRow>>('/jobs', q),
    get: (id: number) => adminGet<AdminJobDetail>(`/jobs/${enc(id)}`),
  },
  proxies: {
    list: () => adminGet<Paged<AdminProxy>>('/proxies'),
    create: (body: Required<ProxyWrite>) => adminSend<{ proxy: AdminProxy }>('POST', '/proxies', body),
    update: (id: number, body: ProxyWrite) => adminSend<{ proxy: AdminProxy }>('PATCH', `/proxies/${enc(id)}`, body),
    check: (id: number) => adminSend<{ proxy: AdminProxy }>('POST', `/proxies/${enc(id)}/check`),
  },
};

// ---------------------------------------------------------------- hata metinleri

export const TEST_SCRAPE_THROTTLED = 'Bu kaynak için dakikada en fazla 1 test taraması başlatılabilir. Bir dakika sonra yeniden deneyin.';
export const PROXY_CHECK_THROTTLED = 'Proxy en fazla 10 saniyede bir kontrol edilebilir. Biraz sonra yeniden deneyin.';

/** Test taraması: 429 kaynağa özgü kısıtı söyler; 409 (duraklatılmış, devam eden iş, izin yok) sunucu metniyle. */
export function testScrapeErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return TEST_SCRAPE_THROTTLED;
  return adminErrorMessage(err);
}

export function proxyCheckErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return PROXY_CHECK_THROTTLED;
  return adminErrorMessage(err);
}

export function reanalyzeErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 503) return 'Yeniden analiz şu anda kuyruğa alınamıyor. Kuyruk servisini kontrol edip yeniden deneyin.';
  return adminErrorMessage(err);
}
