import { z } from 'zod';

export const FUELS = ['GASOLINE', 'DIESEL', 'LPG', 'HYBRID', 'ELECTRIC', 'OTHER'] as const;
export const TRANSMISSIONS = ['MANUAL', 'AUTOMATIC', 'SEMI_AUTOMATIC'] as const;
export const CONFIDENCES = ['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH'] as const;
export const MATCH_REASONS = ['NEW', 'PRICE_DROP', 'RELIST'] as const;
/** İlan bildirimi kanalları. EMAIL ilan bildirimi MVP'de kapalıdır (spec §5.4). */
export const PROFILE_CHANNELS = ['IN_APP', 'TELEGRAM'] as const;

export type Fuel = (typeof FUELS)[number];
export type Transmission = (typeof TRANSMISSIONS)[number];
export type ConfidenceLevel = (typeof CONFIDENCES)[number];
export type MatchReasonValue = (typeof MATCH_REASONS)[number];
export type ProfileChannel = (typeof PROFILE_CHANNELS)[number];

export function confidenceAtLeast(c: ConfidenceLevel): ConfidenceLevel[] {
  return CONFIDENCES.slice(CONFIDENCES.indexOf(c));
}

const money = z.string().regex(/^\d{1,12}$/, 'TL tam sayı (rakam dizgisi) olmalı');
const text = (max: number) => z.string().trim().min(1).max(max);
const year = z.number().int().min(1950).max(2100);
const fraction = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'en fazla 4 ondalık basamak');

export const searchProfileFieldsSchema = z
  .object({
    name: text(60),
    make: text(40).nullable().optional(),
    model: text(60).nullable().optional(),
    yearMin: year.nullable().optional(),
    yearMax: year.nullable().optional(),
    priceMin: money.nullable().optional(),
    priceMax: money.nullable().optional(),
    kmMax: z.number().int().min(0).max(2_000_000).nullable().optional(),
    fuels: z.array(z.enum(FUELS)).max(FUELS.length).optional(),
    transmissions: z.array(z.enum(TRANSMISSIONS)).max(TRANSMISSIONS.length).optional(),
    cities: z.array(text(40)).max(20).optional(),
    minDiscountPct: fraction(0, 0.9).optional(),
    minConfidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    excludeDamaged: z.boolean().optional(),
    notifyOnPriceDrop: z.boolean().optional(),
    priceDropPct: fraction(0.01, 0.5).optional(),
    notifyOnRelist: z.boolean().optional(),
    channels: z.array(z.enum(PROFILE_CHANNELS)).max(PROFILE_CHANNELS.length).optional(),
  })
  .strict();

type ConsistencyFields = Partial<
  Pick<z.infer<typeof searchProfileFieldsSchema>, 'make' | 'model' | 'yearMin' | 'yearMax' | 'priceMin' | 'priceMax'>
>;

/** Alanlar arası tutarlılık; oluşturma, güncelleme sonrası birleşik kayıt ve önizleme için ortak. */
export function checkProfileConsistency(v: ConsistencyFields, ctx: z.RefinementCtx): void {
  if (v.model && !v.make) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model için marka seçilmelidir' });
  if (v.yearMin != null && v.yearMax != null && v.yearMin > v.yearMax)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['yearMax'], message: 'yearMax, yearMin değerinden küçük olamaz' });
  if (v.priceMin != null && v.priceMax != null && BigInt(v.priceMin) > BigInt(v.priceMax))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMax'], message: 'priceMax, priceMin değerinden küçük olamaz' });
}

export const createSearchProfileSchema = searchProfileFieldsSchema.superRefine(checkProfileConsistency);
export type CreateSearchProfileInput = z.infer<typeof createSearchProfileSchema>;

export const updateSearchProfileSchema = searchProfileFieldsSchema
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'En az bir alan gönderilmelidir');
export type UpdateSearchProfileInput = z.infer<typeof updateSearchProfileSchema>;

export const previewSearchProfileSchema = searchProfileFieldsSchema
  .pick({
    make: true, model: true, yearMin: true, yearMax: true, priceMin: true, priceMax: true, kmMax: true,
    fuels: true, transmissions: true, cities: true, minDiscountPct: true, minConfidence: true, excludeDamaged: true,
  })
  .strict()
  .superRefine(checkProfileConsistency);
export type PreviewSearchProfileInput = z.infer<typeof previewSearchProfileSchema>;

export interface NormalizedProfile {
  name: string;
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
  minConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  excludeDamaged: boolean;
  notifyOnPriceDrop: boolean;
  priceDropPct: number;
  notifyOnRelist: boolean;
  channels: ProfileChannel[];
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Varsayılanlar DB varsayılanlarıyla aynıdır (schema.prisma SearchProfile). */
export function withProfileDefaults(i: CreateSearchProfileInput): NormalizedProfile {
  return {
    name: i.name,
    make: i.make ?? null,
    model: i.model ?? null,
    yearMin: i.yearMin ?? null,
    yearMax: i.yearMax ?? null,
    priceMin: i.priceMin ?? null,
    priceMax: i.priceMax ?? null,
    kmMax: i.kmMax ?? null,
    fuels: uniq(i.fuels ?? []),
    transmissions: uniq(i.transmissions ?? []),
    cities: uniq(i.cities ?? []),
    minDiscountPct: i.minDiscountPct ?? 0,
    minConfidence: i.minConfidence ?? 'MEDIUM',
    excludeDamaged: i.excludeDamaged ?? false,
    notifyOnPriceDrop: i.notifyOnPriceDrop ?? true,
    priceDropPct: i.priceDropPct ?? 0.05,
    notifyOnRelist: i.notifyOnRelist ?? false,
    channels: uniq<ProfileChannel>(['IN_APP', ...(i.channels ?? [])]),
  };
}

export const listMatchesQuerySchema = z
  .object({
    profileId: z.string().min(1).max(40).optional(),
    reason: z.enum(MATCH_REASONS).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    cursor: z.coerce.number().int().positive().max(2_147_483_647).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListMatchesQuery = z.infer<typeof listMatchesQuerySchema>;
