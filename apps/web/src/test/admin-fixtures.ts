import { act } from 'react';
import { http, HttpResponse } from 'msw';

/** Admin testleri için ortak yardımcılar (Task 10–12). */

export type TestRole = 'USER' | 'ADMIN' | 'SUPER_ADMIN';

export const ME_ID = 'me-1';

export function meHandler(role: TestRole, over: Record<string, unknown> = {}) {
  return http.get('*/api/v1/me', () =>
    HttpResponse.json({
      user: {
        id: ME_ID,
        email: 'yonetici@oto.test',
        name: 'Deniz Yönetici',
        role,
        status: 'ACTIVE',
        emailVerifiedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...over,
      },
    }),
  );
}

export function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json({ error: { code, message, details } }, { status });
}

export function overviewFixture(over: Record<string, unknown> = {}) {
  return {
    users: { total: 1284, active: 1250, suspended: 12, newToday: 9 },
    profiles: { active: 2210 },
    listings: { active: 48210, newToday: 1320, removedToday: 410 },
    opportunities: { count: 318 },
    notifications: { sentToday: 5120, failedToday: 14, skippedLimitToday: 61 },
    queues: { scrape: 3, analyze: 120, match: 0, notify: 4, 'notify-telegram': 1 },
    workers: { alive: 3, dead: 0 },
    sources: [
      { id: 1, code: 'demo-site', health: 'HEALTHY', isActive: true, permissionVerifiedAt: '2026-10-01T09:00:00.000Z', lastSuccessAt: '2026-10-11T09:58:00.000Z' },
      { id: 2, code: 'partner-feed', health: 'DOWN', isActive: true, permissionVerifiedAt: '2026-10-01T09:00:00.000Z', lastSuccessAt: null },
    ],
    latency: { p50: 4200, p95: 18400 },
    ...over,
  };
}

export const plansFixture = {
  total: 3,
  items: [
    { id: 'p-free', code: 'FREE', name: 'Ücretsiz', priceMonthly: 0, isActive: true, activeSubscriptions: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      limits: { maxSearchProfiles: 1, maxNotificationsPerDay: 10, channels: ['IN_APP'], opportunitiesDelayHours: 24 } },
    { id: 'p-pro', code: 'PRO', name: 'Pro', priceMonthly: 299, isActive: true, activeSubscriptions: 12, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      limits: { maxSearchProfiles: 10, maxNotificationsPerDay: 200, channels: ['IN_APP', 'TELEGRAM'], opportunitiesDelayHours: 0 } },
    { id: 'p-old', code: 'LEGACY', name: 'Eski paket', priceMonthly: 99, isActive: false, activeSubscriptions: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      limits: { maxSearchProfiles: 3, maxNotificationsPerDay: 50, channels: ['IN_APP'], opportunitiesDelayHours: 6 } },
  ],
};

/** EventSource sahtesi: `emit` olayları act() içinde dağıtır. */
export class FakeES {
  static instances: FakeES[] = [];
  closed = false;
  withCredentials: boolean;
  private l = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(
    readonly url: string,
    init?: { withCredentials?: boolean },
  ) {
    this.withCredentials = init?.withCredentials ?? false;
    FakeES.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    this.l.set(t, [...(this.l.get(t) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(t: string, data: unknown) {
    act(() => {
      for (const fn of this.l.get(t) ?? []) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
    });
  }
  static last(): FakeES {
    const es = FakeES.instances[FakeES.instances.length - 1];
    if (!es) throw new Error('no EventSource');
    return es;
  }
}
