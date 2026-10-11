'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminSourceUpdate } from '@oto/shared';
import { adminKeys } from '../admin-queries';
import {
  catalogApi,
  isTerminalJob,
  type AdminAnalysesQuery,
  type AdminIssuesQuery,
  type AdminJobsQuery,
  type AdminListingsQuery,
  type StatsRange,
} from './catalog-api';

/**
 * Task 11 sorgu anahtarları. Hepsi `'admin'` köküyle başlar. `jobs` ve `sources` `adminKeys.jobs.all` /
 * `adminKeys.sources.all` altında: akıştaki `job` olayı ikisini de geçersiz kılar, yani iş/kaynak ekranları
 * canlı akış açıkken kendiliğinden tazelenir. Proxy anahtarı yalnızca maskeli URL'leri tutar.
 */
export const catalogKeys = {
  listings: {
    all: ['admin', 'listings'] as const,
    list: (q: AdminListingsQuery) => ['admin', 'listings', 'list', q] as const,
    detail: (id: number) => ['admin', 'listings', 'detail', id] as const,
    issues: (q: AdminIssuesQuery) => ['admin', 'listings', 'issues', q] as const,
  },
  analyses: {
    all: ['admin', 'analyses'] as const,
    list: (q: AdminAnalysesQuery) => ['admin', 'analyses', 'list', q] as const,
    detail: (id: number) => ['admin', 'analyses', 'detail', id] as const,
  },
  sources: {
    all: adminKeys.sources.all,
    list: () => [...adminKeys.sources.all, 'list'] as const,
    detail: (id: number) => [...adminKeys.sources.all, 'detail', id] as const,
    stats: (id: number, range: StatsRange) => [...adminKeys.sources.all, 'stats', id, range] as const,
  },
  jobs: {
    all: adminKeys.jobs.all,
    list: (q: AdminJobsQuery) => [...adminKeys.jobs.all, 'list', q] as const,
    detail: (id: number) => [...adminKeys.jobs.all, 'detail', id] as const,
  },
  proxies: {
    all: ['admin', 'proxies'] as const,
    list: () => ['admin', 'proxies', 'list'] as const,
  },
};

/** Akış kopuksa iş/yeniden analiz sonucunu bu aralıkla yoklarız. */
export const POLL_MS = 3_000;

// ---------------------------------------------------------------- ilanlar ve analizler

export function useAdminListings(q: AdminListingsQuery) {
  return useQuery({ queryKey: catalogKeys.listings.list(q), queryFn: () => catalogApi.listings.list(q), placeholderData: keepPreviousData });
}

export function useAdminListing(id: number, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: catalogKeys.listings.detail(id),
    queryFn: () => catalogApi.listings.get(id),
    refetchInterval: opts.poll ? POLL_MS : false,
  });
}

export function useAdminListingIssues(q: AdminIssuesQuery, enabled = true) {
  return useQuery({
    queryKey: catalogKeys.listings.issues(q),
    queryFn: () => catalogApi.listings.issues(q),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAdminAnalyses(q: AdminAnalysesQuery) {
  return useQuery({ queryKey: catalogKeys.analyses.list(q), queryFn: () => catalogApi.analyses.list(q), placeholderData: keepPreviousData });
}

export function useAdminAnalysis(id: number | null) {
  return useQuery({
    queryKey: catalogKeys.analyses.detail(id ?? 0),
    queryFn: () => catalogApi.analyses.get(id!),
    enabled: id !== null,
    staleTime: Infinity, // analiz satırları değişmez
  });
}

export function useReanalyze(id: number) {
  return useMutation({ mutationFn: () => catalogApi.listings.reanalyze(id) });
}

// ---------------------------------------------------------------- kaynaklar

export function useAdminSources() {
  return useQuery({ queryKey: catalogKeys.sources.list(), queryFn: catalogApi.sources.list });
}

export function useAdminSource(id: number) {
  return useQuery({ queryKey: catalogKeys.sources.detail(id), queryFn: () => catalogApi.sources.get(id) });
}

export function useAdminSourceStats(id: number, range: StatsRange) {
  return useQuery({
    queryKey: catalogKeys.sources.stats(id, range),
    queryFn: () => catalogApi.sources.stats(id, range),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateSources() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: catalogKeys.sources.all }),
      qc.invalidateQueries({ queryKey: adminKeys.overview() }),
    ]);
}

export type SourceAction = 'activate' | 'pause';

export function useSourceAction(id: number) {
  const invalidate = useInvalidateSources();
  return useMutation({
    mutationFn: (a: SourceAction) => (a === 'activate' ? catalogApi.sources.activate(id) : catalogApi.sources.pause(id)),
    onSettled: invalidate,
  });
}

/** Başarıda yanıt önce detay önbelleğine yazılır: form yeniden kurulduğunda bayat değerle başlamasın. */
export function useUpdateSource(id: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidateSources();
  return useMutation({
    mutationFn: (body: AdminSourceUpdate) => catalogApi.sources.update(id, body),
    onSuccess: (res) => {
      qc.setQueryData(catalogKeys.sources.detail(id), res);
      return invalidate();
    },
  });
}

export function useTestScrape(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => catalogApi.sources.testScrape(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: catalogKeys.jobs.all }),
  });
}

// ---------------------------------------------------------------- işler

export function useAdminJobs(q: AdminJobsQuery) {
  return useQuery({ queryKey: catalogKeys.jobs.list(q), queryFn: () => catalogApi.jobs.list(q), placeholderData: keepPreviousData });
}

/** İş bitene kadar yoklanır (akış `job` olayıyla da anında tazelenir). */
export function useAdminJob(id: number | null) {
  return useQuery({
    queryKey: catalogKeys.jobs.detail(id ?? 0),
    queryFn: () => catalogApi.jobs.get(id!),
    enabled: id !== null,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false;
      const s = q.state.data?.job.status;
      return s && isTerminalJob(s) ? false : POLL_MS;
    },
  });
}

// ---------------------------------------------------------------- proxy'ler

export function useAdminProxies() {
  return useQuery({ queryKey: catalogKeys.proxies.list(), queryFn: catalogApi.proxies.list });
}
