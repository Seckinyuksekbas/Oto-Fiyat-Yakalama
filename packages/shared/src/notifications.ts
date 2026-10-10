import { z } from 'zod';

const money = z.string().regex(/^-?\d+$/);
const iso = z.string().datetime();

export const matchNotificationPayloadSchema = z.object({
  type: z.literal('MATCH'),
  reason: z.enum(['NEW', 'PRICE_DROP', 'RELIST']),
  profile: z.object({ id: z.string(), name: z.string() }),
  listing: z.object({
    id: z.number().int(), title: z.string(), make: z.string(), model: z.string(), trim: z.string().nullable(),
    year: z.number().int(), km: z.number().int(), fuel: z.string(), transmission: z.string(), city: z.string().nullable(),
    price: money, imageUrl: z.string().nullable(), url: z.string(), firstSeenAt: iso,
  }),
  analysis: z.object({
    opportunityScore: z.number().int(), confidence: z.enum(['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH']),
    estimatedPrice: money.nullable(), priceDiff: money.nullable(), discountPct: z.number().nullable(), comparableCount: z.number().int(),
  }),
  previousPrice: money.nullable(),
  limitExceeded: z.boolean(),
});
export type MatchNotificationPayload = z.infer<typeof matchNotificationPayloadSchema>;

export const securityNotificationPayloadSchema = z.object({
  type: z.enum(['TELEGRAM_LINKED', 'TELEGRAM_DISABLED', 'REFRESH_REUSED']),
  reason: z.string().optional(),
  familyId: z.string().optional(),
});
export type SecurityNotificationPayload = z.infer<typeof securityNotificationPayloadSchema>;

/** Redis pub/sub kanalı: API SSE akışı buna abone olur. */
export function userEventChannel(userId: string): string {
  return `user:${userId}`;
}

export const userEventSchema = z.object({
  type: z.literal('notification'),
  notification: z.object({
    id: z.number().int(),
    kind: z.enum(['MATCH', 'SECURITY', 'SYSTEM_ALERT']),
    channel: z.literal('IN_APP'),
    status: z.string(),
    payload: z.unknown(),
    createdAt: iso,
  }),
});
export type UserEvent = z.infer<typeof userEventSchema>;
