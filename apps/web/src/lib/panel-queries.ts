'use client';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CatalogMakes, CatalogModels, FavoriteItem, ListingCard, ListingDetail } from '@oto/shared';
import { ApiError, apiFetch } from './api';

/**
 * Kök anahtarlar FavoriteButton'un önbellek yamasıyla uyumludur:
 * ['opportunities'], ['favorites'], ['listing', id], ['dashboard'].
 */
export const panelKeys = {
  opportunities: (params: Record<string, string | undefined>) => ['opportunities', params] as const,
  favorites: () => ['favorites'] as const,
  listing: (id: number) => ['listing', id] as const,
  makes: ['catalog', 'makes'] as const,
  models: (make: string) => ['catalog', 'models', make] as const,
  matches: (params: Record<string, string | undefined>) => ['matches', params] as const,
  profiles: ['search-profiles'] as const,
};

export const MATCH_REASON_LABEL = {
  NEW: 'Yeni ilan',
  PRICE_DROP: 'Fiyat düştü',
  RELIST: 'Yeniden yayında',
} as const;

export const LEGAL_NOTE =
  'Fiyat tahminleri benzer ilanlardan türetilen istatistiksel göstergelerdir; yatırım ya da değerleme tavsiyesi değildir. Satın almadan önce aracı ve ekspertiz raporunu kontrol edin.';

interface Page<T, C> {
  items: T[];
  nextCursor: C | null;
}

export type OpportunityFilters = Partial<
  Record<'make' | 'model' | 'city' | 'maxPrice' | 'minScore' | 'confidence' | 'sort', string>
>;

export function useOpportunities(filters: OpportunityFilters) {
  return useInfiniteQuery({
    queryKey: panelKeys.opportunities(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<ListingCard, string>>('/me/opportunities', { query: { ...filters, limit: 24, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Dış bağlantı yalnızca http(s) ise gösterilir (javascript: vb. şemalar engellenir). */
export function isHttpUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

export const NEXT_PAGE_ERROR = 'Sonraki sayfa yüklenemedi. Tekrar deneyin.';

const MAX_TEXT = 60;
const ENUMS = { sort: ['score', 'recent', 'discount'], confidence: ['MEDIUM', 'HIGH'] } as const;

function validFilter(key: string, v: string): boolean {
  switch (key) {
    case 'sort':
    case 'confidence':
      return (ENUMS[key] as readonly string[]).includes(v);
    case 'minScore':
      return /^\d{2,3}$/.test(v) && Number(v) >= 60 && Number(v) <= 100;
    case 'maxPrice':
      return /^\d{1,15}$/.test(v);
    default:
      return v.trim().length > 0 && v.length <= MAX_TEXT;
  }
}

export const OPPORTUNITY_FILTER_KEYS = ['make', 'model', 'city', 'maxPrice', 'minScore', 'confidence', 'sort'] as const;

/** URL parametrelerini doğrular: geçersiz/yinelenen/modelsiz değerler atılır. `clean` temizlenmiş sorgu dizesidir. */
export function parseOpportunityParams(sp: URLSearchParams): { filters: OpportunityFilters; clean: string } {
  const filters: OpportunityFilters = {};
  const hasMake = !!sp.get('make') && validFilter('make', sp.get('make') ?? '');
  const kept = new URLSearchParams();
  for (const [k, v] of sp) {
    if (!(OPPORTUNITY_FILTER_KEYS as readonly string[]).includes(k)) {
      kept.append(k, v);
      continue;
    }
    const key = k as (typeof OPPORTUNITY_FILTER_KEYS)[number];
    if (filters[key] !== undefined || !validFilter(k, v) || (k === 'model' && !hasMake)) continue;
    filters[key] = v;
    kept.append(k, v);
  }
  return { filters, clean: kept.toString() };
}

export function useCatalogMakes() {
  return useQuery({
    queryKey: panelKeys.makes,
    queryFn: () => apiFetch<CatalogMakes>('/catalog/makes'),
    staleTime: 5 * 60_000,
  });
}

export function useCatalogModels(make: string | undefined) {
  return useQuery({
    queryKey: panelKeys.models(make ?? ''),
    queryFn: () => apiFetch<CatalogModels>(`/catalog/makes/${encodeURIComponent(make ?? '')}/models`),
    enabled: !!make,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useListing(id: number | null) {
  return useQuery({
    queryKey: panelKeys.listing(id ?? 0),
    queryFn: () => apiFetch<ListingDetail>(`/me/listings/${id}`),
    enabled: id !== null,
    retry: (count, err) => {
      const status = err instanceof ApiError ? err.status : 0;
      return (status === 0 || status >= 500) && count < 2;
    },
  });
}

export function useFavorites() {
  return useInfiniteQuery({
    queryKey: panelKeys.favorites(),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => apiFetch<Page<FavoriteItem, number>>('/me/favorites', { query: { limit: 24, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export interface MatchRow {
  id: number;
  reason: keyof typeof MATCH_REASON_LABEL;
  matchedPrice: string;
  createdAt: string;
  profile: { id: string; name: string };
  listing: {
    id: number;
    title: string;
    make: string;
    model: string;
    year: number;
    km: number;
    city: string | null;
    price: string;
    imageUrl: string | null;
    url: string;
    status: 'ACTIVE' | 'REMOVED';
  };
  analysis: {
    opportunityScore: number;
    confidence: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
    discountPct: number | null;
    estimatedPrice: string | null;
  };
}

export function useMatches(filters: Record<string, string | undefined>) {
  return useInfiniteQuery({
    queryKey: panelKeys.matches(filters),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => apiFetch<Page<MatchRow, number>>('/me/matches', { query: { ...filters, limit: 20, cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useSearchProfileOptions() {
  return useQuery({
    queryKey: panelKeys.profiles,
    queryFn: async () => {
      const r = await apiFetch<unknown>('/me/search-profiles');
      const list = Array.isArray(r) ? r : ((r as { items?: unknown[] } | null)?.items ?? []);
      return (list as Array<{ id: string; name: string }>).map((p) => ({ id: p.id, name: p.name }));
    },
  });
}
