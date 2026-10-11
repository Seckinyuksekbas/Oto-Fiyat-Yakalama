'use client';
import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSearchProfileSchema,
  previewSearchProfileSchema,
  type CreateSearchProfileInput,
  type Fuel,
  type PreviewSearchProfileInput,
  type Transmission,
} from '@oto/shared';
import { ApiError, apiFetch } from './api';
import { CHANNELS_KEY, type ChannelsResponse } from './channels';
import { queryKeys, useMe, type MeResponse } from './queries';

/* ------------------------------------------------------------------ */
/* Tipler                                                             */
/* ------------------------------------------------------------------ */

export interface SearchProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | string;
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  priceMin: string | null;
  priceMax: string | null;
  kmMax: number | null;
  fuels: Fuel[];
  transmissions: Transmission[];
  cities: string[];
  minDiscountPct: number;
  minConfidence: 'LOW' | 'MEDIUM' | 'HIGH' | string;
  excludeDamaged: boolean;
  notifyOnPriceDrop: boolean;
  priceDropPct: number;
  notifyOnRelist: boolean;
  channels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PreviewItem {
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
  firstSeenAt: string;
  analysis: {
    opportunityScore: number;
    confidence: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
    discountPct: number | null;
    estimatedPrice: string | null;
  };
}

export interface PreviewResult {
  items: PreviewItem[];
  estimatedDailyMatches: number;
}

/** /me yanıtı; abonelik limitleri profil formu için gerekli. */
export interface ProfileLimits {
  maxProfiles: number;
  emailVerified: boolean;
  telegramInPlan: boolean;
}

/* ------------------------------------------------------------------ */
/* Sorgu anahtarları                                                  */
/* ------------------------------------------------------------------ */

export const profileKeys = {
  all: ['profiles'] as const,
  list: ['profiles', 'list'] as const,
  detail: (id: string) => ['profiles', 'detail', id] as const,
  preview: (hash: string) => ['profiles', 'preview', hash] as const,
  channels: CHANNELS_KEY,
};

/* ------------------------------------------------------------------ */
/* Form durumu <-> API yükü                                           */
/* ------------------------------------------------------------------ */

export type CriteriaMode = 'DEALS' | 'ALL';

export interface ProfileFormState {
  name: string;
  make: string;
  model: string;
  yearMin: string;
  yearMax: string;
  kmMax: string;
  fuels: Fuel[];
  transmissions: Transmission[];
  cities: string[];
  mode: CriteriaMode;
  /** Yüzde olarak (5-50); yalnızca mode=DEALS iken gönderilir. */
  discountPct: number;
  minConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  priceMin: string;
  priceMax: string;
  excludeDamaged: boolean;
  notifyOnPriceDrop: boolean;
  /** Yüzde olarak (1-50). */
  priceDropPct: number;
  notifyOnRelist: boolean;
  telegram: boolean;
}

export const DEFAULT_FORM: ProfileFormState = {
  name: '',
  make: '',
  model: '',
  yearMin: '',
  yearMax: '',
  kmMax: '',
  fuels: [],
  transmissions: [],
  cities: [],
  mode: 'DEALS',
  discountPct: 15,
  minConfidence: 'MEDIUM',
  priceMin: '',
  priceMax: '',
  excludeDamaged: true,
  notifyOnPriceDrop: true,
  priceDropPct: 5,
  notifyOnRelist: false,
  telegram: false,
};

const toInt = (s: string): number | null => {
  const t = s.replace(/\D/g, '');
  return t === '' ? null : Number(t);
};
const toMoney = (s: string): string | null => {
  const t = s.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return t === '' ? null : t;
};
const fraction = (pct: number) => Math.round(pct * 100) / 10_000;

export function profileToForm(p: SearchProfile): ProfileFormState {
  const deals = p.minDiscountPct > 0;
  return {
    name: p.name,
    make: p.make ?? '',
    model: p.model ?? '',
    yearMin: p.yearMin?.toString() ?? '',
    yearMax: p.yearMax?.toString() ?? '',
    kmMax: p.kmMax?.toString() ?? '',
    fuels: p.fuels,
    transmissions: p.transmissions,
    cities: p.cities,
    mode: deals ? 'DEALS' : 'ALL',
    discountPct: deals ? Math.round(p.minDiscountPct * 100) : DEFAULT_FORM.discountPct,
    minConfidence: p.minConfidence === 'LOW' || p.minConfidence === 'HIGH' ? p.minConfidence : 'MEDIUM',
    priceMin: p.priceMin ?? '',
    priceMax: p.priceMax ?? '',
    excludeDamaged: p.excludeDamaged,
    notifyOnPriceDrop: p.notifyOnPriceDrop,
    priceDropPct: Math.round(p.priceDropPct * 100),
    notifyOnRelist: p.notifyOnRelist,
    telegram: p.channels.includes('TELEGRAM'),
  };
}

/** Tam yük (oluşturma ve fark hesabı için). "Tüm yeni ilanlar" iken minDiscountPct = 0. */
export function formToPayload(f: ProfileFormState): CreateSearchProfileInput {
  const out: CreateSearchProfileInput = {
    name: f.name.trim(),
    make: f.make.trim() || null,
    model: f.make.trim() ? f.model.trim() || null : null,
    yearMin: toInt(f.yearMin),
    yearMax: toInt(f.yearMax),
    priceMin: toMoney(f.priceMin),
    priceMax: toMoney(f.priceMax),
    kmMax: toInt(f.kmMax),
    fuels: f.fuels,
    transmissions: f.transmissions,
    cities: f.cities,
    minDiscountPct: f.mode === 'ALL' ? 0 : fraction(f.discountPct),
    excludeDamaged: f.excludeDamaged,
    notifyOnPriceDrop: f.notifyOnPriceDrop,
    notifyOnRelist: f.notifyOnRelist,
    channels: f.telegram ? ['IN_APP', 'TELEGRAM'] : ['IN_APP'],
  };
  // Güven yalnızca "Yalnızca fırsatlar" modunda anlamlı; eşik yalnızca düşüş bildirimi açıkken.
  if (f.mode === 'DEALS') out.minConfidence = f.minConfidence;
  if (f.notifyOnPriceDrop) out.priceDropPct = fraction(f.priceDropPct);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** PATCH gövdesi: yalnızca değişen alanlar. */
export function diffPayload(
  next: CreateSearchProfileInput,
  prev: CreateSearchProfileInput,
): Partial<CreateSearchProfileInput> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next) as Array<keyof CreateSearchProfileInput>) {
    if (!same(next[k], prev[k])) out[k] = next[k];
  }
  return out as Partial<CreateSearchProfileInput>;
}

/** Önizleme yükü: ad ve bildirim ayarları yok; "Tüm yeni ilanlar" iken güven alanı gönderilmez. */
export function formToPreview(f: ProfileFormState): PreviewSearchProfileInput {
  const p = formToPayload(f);
  const out: PreviewSearchProfileInput = {
    make: p.make,
    model: p.model,
    yearMin: p.yearMin,
    yearMax: p.yearMax,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    kmMax: p.kmMax,
    fuels: p.fuels,
    transmissions: p.transmissions,
    cities: p.cities,
    minDiscountPct: p.minDiscountPct,
    excludeDamaged: p.excludeDamaged,
  };
  if (p.minConfidence) out.minConfidence = p.minConfidence;
  return out;
}

export function isPreviewable(p: PreviewSearchProfileInput): boolean {
  return previewSearchProfileSchema.safeParse(p).success;
}

/** Önizleme isteğini etkileyen alanlar (canlı hata listesi için). */
export const PREVIEW_FIELDS = new Set([
  'make', 'model', 'yearMin', 'yearMax', 'priceMin', 'priceMax', 'kmMax', 'fuels', 'transmissions', 'cities', 'minDiscountPct', 'minConfidence',
]);

export type FieldErrors = Partial<Record<string, string>>;

const RANGE_MESSAGES: Record<string, string> = {
  kmMax: 'Km 0 ile 2.000.000 arasında olmalı',
  yearMin: 'Yıl 1950 ile 2100 arasında olmalı',
  yearMax: 'Yıl 1950 ile 2100 arasında olmalı',
  priceMin: 'Geçerli bir tutar girin',
  priceMax: 'Geçerli bir tutar girin',
  priceDropPct: 'Düşüş eşiği %1 ile %50 arasında olmalı',
  minDiscountPct: 'İndirim %5 ile %50 arasında olmalı',
};
const CONSISTENCY_MESSAGES: Record<string, string> = {
  model: 'Model seçmek için önce marka seçin',
  yearMax: 'En yeni yıl, en eski yıldan küçük olamaz',
  priceMax: 'En yüksek fiyat, en düşük fiyattan küçük olamaz',
};

/** İstemci tarafı tam doğrulama; sunucuyla aynı şema. */
export function validatePayload(p: CreateSearchProfileInput): FieldErrors {
  const out: FieldErrors = {};
  if (!p.name) out.name = 'Profile bir ad verin';
  const r = createSearchProfileSchema.safeParse(p);
  if (!r.success) {
    for (const i of r.error.issues) {
      const key = String(i.path[0] ?? '');
      if (!key || key === 'name' || out[key]) continue;
      out[key] =
        i.code === 'custom' ? (CONSISTENCY_MESSAGES[key] ?? i.message) : (RANGE_MESSAGES[key] ?? 'Geçersiz değer');
    }
  }
  return out;
}

/** VALIDATION_FAILED details ([{path, message}]) -> alan hataları. */
export function detailsToFieldErrors(details: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!Array.isArray(details)) return out;
  for (const d of details as Array<{ path?: unknown; message?: unknown }>) {
    const key = typeof d.path === 'string' ? d.path.split('.')[0] : '';
    if (key && !out[key]) out[key] = typeof d.message === 'string' ? d.message : 'Geçersiz değer';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Hook'lar                                                           */
/* ------------------------------------------------------------------ */

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useProfiles() {
  return useQuery({
    queryKey: profileKeys.list,
    queryFn: () => apiFetch<{ items: SearchProfile[] }>('/me/search-profiles'),
  });
}

export function useProfile(id: string) {
  return useQuery({
    queryKey: profileKeys.detail(id),
    queryFn: () => apiFetch<SearchProfile>(`/me/search-profiles/${encodeURIComponent(id)}`),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

export function useChannelsInfo() {
  return useQuery({ queryKey: profileKeys.channels, queryFn: () => apiFetch<ChannelsResponse>('/me/channels') });
}

export function useProfileLimits(): { limits: ProfileLimits | null; isPending: boolean } {
  const me = useMe();
  const d = me.data as (MeResponse & { subscription?: { limits?: { maxSearchProfiles?: number; channels?: string[] } } }) | undefined;
  if (!d) return { limits: null, isPending: me.isPending };
  const lim = d.subscription?.limits;
  const emailVerified = !!d.user.emailVerifiedAt;
  const plan = lim?.maxSearchProfiles ?? 1;
  return {
    isPending: false,
    limits: {
      maxProfiles: emailVerified ? plan : Math.min(1, plan),
      emailVerified,
      telegramInPlan: (lim?.channels ?? []).includes('TELEGRAM'),
    },
  };
}

function useInvalidateProfiles() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: profileKeys.all });
    void qc.invalidateQueries({ queryKey: ['search-profiles'] });
    void qc.invalidateQueries({ queryKey: queryKeys.me });
    void qc.invalidateQueries({ queryKey: queryKeys.dashboard });
    void qc.invalidateQueries({ queryKey: ['subscription'] });
    void qc.invalidateQueries({ queryKey: ['matches'] });
  };
}

export function useCreateProfile() {
  const inv = useInvalidateProfiles();
  return useMutation({
    mutationFn: (body: CreateSearchProfileInput) => apiFetch<SearchProfile>('/me/search-profiles', { method: 'POST', json: body }),
    onSuccess: inv,
  });
}

export function useUpdateProfile(id: string) {
  const inv = useInvalidateProfiles();
  return useMutation({
    mutationFn: (body: Partial<CreateSearchProfileInput>) =>
      apiFetch<SearchProfile>(`/me/search-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', json: body }),
    onSuccess: inv,
  });
}

export function useSetProfileStatus() {
  const inv = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch<SearchProfile>(`/me/search-profiles/${encodeURIComponent(id)}/${active ? 'resume' : 'pause'}`, { method: 'POST' }),
    onSuccess: inv,
  });
}

export function useDeleteProfile() {
  const inv = useInvalidateProfiles();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/me/search-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: inv,
  });
}

/** Canlı önizleme: 400 ms debounce, geçersiz yükte istek yok, önceki sonuç yeni gelene kadar kalır. */
export function usePreview(payload: PreviewSearchProfileInput) {
  const debounced = useDebounced(payload, 400);
  const hash = JSON.stringify(debounced);
  const valid = isPreviewable(debounced);
  const q = useQuery({
    queryKey: profileKeys.preview(hash),
    queryFn: () => apiFetch<PreviewResult>('/me/search-profiles/preview', { method: 'POST', json: debounced }),
    enabled: valid,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  return { ...q, valid: isPreviewable(payload), settling: JSON.stringify(payload) !== hash };
}

/* ------------------------------------------------------------------ */
/* Hata metinleri                                                     */
/* ------------------------------------------------------------------ */

export interface LimitNotice {
  message: string;
  href: string;
  cta: string;
}

/** LIMIT_REACHED -> kullanıcıya Türkçe açıklama ve yönlendirme. */
export function limitNotice(err: unknown): LimitNotice | null {
  if (!(err instanceof ApiError) || err.code !== 'LIMIT_REACHED') return null;
  const d = (err.details ?? {}) as { reason?: string; channel?: string; limit?: number };
  if (d.reason === 'EMAIL_NOT_VERIFIED') {
    return {
      message: 'E-postanızı doğrulayana kadar yalnızca 1 arama profiliniz olabilir. Gelen kutunuzdaki doğrulama bağlantısına tıklayın.',
      href: '/app/ayarlar',
      cta: 'Ayarlara git',
    };
  }
  if (d.channel === 'TELEGRAM') {
    return { message: 'Planınız Telegram bildirimlerini içermiyor. Telegram seçeneğini kapatın ya da planı yükseltin.', href: '/app/abonelik', cta: 'Planları gör' };
  }
  return { message: 'Planınızın arama profili sınırına ulaştınız. Yeni profil için planı yükseltin ya da bir profili silin.', href: '/app/abonelik', cta: 'Planları gör' };
}
