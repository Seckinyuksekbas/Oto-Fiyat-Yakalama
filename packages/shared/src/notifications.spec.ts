import { describe, expect, it } from 'vitest';
import {
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  matchNotificationPayloadSchema,
  notifyJobId,
  notifyJobSchema,
  patchChannelSchema,
  userEventChannel,
  userEventSchema,
} from './index';

const payload = {
  type: 'MATCH', reason: 'NEW', profile: { id: 'p1', name: 'BMW' },
  listing: { id: 1, title: 'Temiz 320i', make: 'BMW', model: '3 Serisi', trim: '320i', year: 2019, km: 85000, fuel: 'GASOLINE',
    transmission: 'AUTOMATIC', city: 'İstanbul', price: '960000', imageUrl: null, url: 'https://ornek.com/ilan/1', firstSeenAt: '2026-10-10T11:32:00.000Z' },
  analysis: { opportunityScore: 77, confidence: 'HIGH', estimatedPrice: '1200000', priceDiff: '240000', discountPct: 0.2, comparableCount: 14 },
  previousPrice: null, limitExceeded: false,
};

describe('notification contracts', () => {
  it('match payload round-trips and rejects numeric money', () => {
    expect(matchNotificationPayloadSchema.parse(payload)).toEqual(payload);
    expect(matchNotificationPayloadSchema.safeParse({ ...payload, listing: { ...payload.listing, price: 960000 } }).success).toBe(false);
  });
  it('eventAt is optional (old rows) but validated as ISO when present', () => {
    expect(matchNotificationPayloadSchema.parse({ ...payload, eventAt: '2026-10-10T12:00:00.000Z' }).eventAt).toBe('2026-10-10T12:00:00.000Z');
    expect(matchNotificationPayloadSchema.parse(payload).eventAt).toBeUndefined();
    expect(matchNotificationPayloadSchema.safeParse({ ...payload, eventAt: 'dün' }).success).toBe(false);
  });
  it('notify job id and schema', () => {
    expect(notifyJobId(42)).toBe('notify-42');
    expect(notifyJobSchema.safeParse({ notificationId: 0 }).success).toBe(false);
  });
  it('user event channel and schema', () => {
    expect(userEventChannel('abc')).toBe('user:abc');
    expect(userEventSchema.safeParse({ type: 'notification', notification: { id: 1, kind: 'MATCH', channel: 'IN_APP', status: 'SENT', payload, createdAt: '2026-10-10T11:32:00.000Z' } }).success).toBe(true);
  });
  it('list query coerces unread and bounds cursor/limit', () => {
    expect(listNotificationsQuerySchema.parse({ unread: 'true', limit: '5' })).toMatchObject({ unread: true, limit: 5 });
    expect(listNotificationsQuerySchema.safeParse({ cursor: '3000000000' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ foo: '1' }).success).toBe(false);
  });
  it('mark read accepts ids or all', () => {
    expect(markNotificationsReadSchema.safeParse({ ids: [1, 2] }).success).toBe(true);
    expect(markNotificationsReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markNotificationsReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({ all: false }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({}).success).toBe(false);
  });
  it('patch channel is strict', () => {
    expect(patchChannelSchema.safeParse({ isEnabled: true }).success).toBe(true);
    expect(patchChannelSchema.safeParse({ isEnabled: true, config: 'x' }).success).toBe(false);
  });
});
