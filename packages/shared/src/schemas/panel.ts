import { z } from 'zod';
import { planLimitsSchema } from '../plan';

const money = z.string().regex(/^-?\d+$/);
const iso = z.string().datetime();
const confidence = z.enum(['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH']);
const listingStatus = z.enum(['ACTIVE', 'REMOVED']);
const matchReason = z.enum(['NEW', 'PRICE_DROP', 'RELIST']);
const profileRef = z.object({ id: z.string(), name: z.string() });

export const analysisSummarySchema = z.object({
  opportunityScore: z.number(),
  confidence,
  estimatedPrice: money.nullable(),
  priceDiff: money.nullable(),
  discountPct: z.number().nullable(),
  comparableCount: z.number().int(),
  band: z.object({ q1: money.nullable(), median: money.nullable(), q3: money.nullable() }),
  flags: z.array(z.string()),
  insufficientReason: z.enum(['NONE', 'NO_LEVEL', 'AFTER_OUTLIERS', 'INVALID_TARGET']),
});
export type AnalysisSummary = z.infer<typeof analysisSummarySchema>;

export const listingCardSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  make: z.string(),
  model: z.string(),
  trim: z.string().nullable(),
  year: z.number().int(),
  km: z.number().int(),
  fuel: z.string(),
  transmission: z.string(),
  city: z.string().nullable(),
  price: money,
  imageUrl: z.string().nullable(),
  url: z.string(),
  status: listingStatus,
  firstSeenAt: iso,
  analysis: analysisSummarySchema.nullable(),
  isFavorite: z.boolean(),
});
export type ListingCard = z.infer<typeof listingCardSchema>;

export const opportunitiesQuerySchema = z
  .object({
    make: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
    city: z.string().min(1).max(100).optional(),
    maxPrice: z.string().regex(/^\d{1,15}$/).optional(),
    minScore: z.coerce.number().int().min(60).max(100).optional(),
    confidence: z.enum(['MEDIUM', 'HIGH']).optional(),
    sort: z.enum(['score', 'recent', 'discount']).default('score'),
    cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(24),
  })
  .strict();
export type OpportunitiesQuery = z.infer<typeof opportunitiesQuerySchema>;

export const listingDetailSchema = listingCardSchema.extend({
  lastSeenAt: iso,
  removedAt: iso.nullable(),
  damageInfo: z
    .object({
      tramerAmount: z.number().optional(),
      paintedParts: z.array(z.string()).optional(),
      changedParts: z.array(z.string()).optional(),
    })
    .nullable(),
  bodyType: z.string().nullable(),
  color: z.string().nullable(),
  sellerType: z.string().nullable(),
  priceHistory: z.array(z.object({ price: money, km: z.number().int(), observedAt: iso })),
  explanation: z.unknown().nullable(),
  comparables: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      city: z.string().nullable(),
      url: z.string(),
      year: z.number().int(),
      km: z.number().int(),
      price: money,
      adjusted: money,
      damaged: z.boolean(),
      outlier: z.boolean(),
      clamped: z.boolean(),
      status: listingStatus,
    }),
  ),
  myMatches: z.array(
    z.object({
      id: z.number().int(),
      reason: matchReason,
      matchedPrice: money,
      createdAt: iso,
      profile: profileRef,
    }),
  ),
});
export type ListingDetail = z.infer<typeof listingDetailSchema>;

export const favoritesQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(1).max(2147483647).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  })
  .strict();
export type FavoritesQuery = z.infer<typeof favoritesQuerySchema>;

export const putFavoriteSchema = z
  .object({
    note: z
      .string()
      .trim()
      .max(280)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict();
export type PutFavorite = z.infer<typeof putFavoriteSchema>;

export const favoriteItemSchema = z.object({
  listing: listingCardSchema,
  note: z.string().nullable(),
  createdAt: iso,
});
export type FavoriteItem = z.infer<typeof favoriteItemSchema>;

export const dashboardSchema = z.object({
  recentMatches: z.array(
    z.object({
      id: z.number().int(),
      reason: matchReason,
      createdAt: iso,
      profile: profileRef,
      listing: listingCardSchema,
    }),
  ),
  profiles: z.object({ active: z.number().int(), total: z.number().int(), max: z.number().int() }),
  notifications: z.object({ today: z.number().int(), limit: z.number().int() }),
  series: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), matches: z.number().int() })).length(7),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const catalogMakesSchema = z.object({
  items: z.array(z.object({ make: z.string(), count: z.number().int() })),
});
export type CatalogMakes = z.infer<typeof catalogMakesSchema>;

export const catalogModelsSchema = z.object({
  items: z.array(z.object({ model: z.string(), count: z.number().int() })),
});
export type CatalogModels = z.infer<typeof catalogModelsSchema>;

export const subscriptionViewSchema = z.object({
  planCode: z.string(),
  planName: z.string(),
  status: z.string(),
  endsAt: iso.nullable(),
  limits: planLimitsSchema,
  usage: z.object({ searchProfiles: z.number().int(), notificationsToday: z.number().int() }),
});
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

// Server-only helpers: Buffer is accessed lazily inside function bodies.
export function encodeCursor(v: object): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor<T>(s: string, schema: z.ZodType<T>): T | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(s)) return null;
  try {
    const r = schema.safeParse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
