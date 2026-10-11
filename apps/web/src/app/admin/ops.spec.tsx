import { cloneElement } from 'react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { apiError, meHandler, plansFixture } from '@/test/admin-fixtures';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/sistem',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// jsdom'da ölçü yok: grafik kabını sabit boyutla çiz.
vi.mock('recharts', async (orig) => {
  const mod = await orig<typeof import('recharts')>();
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 400, height: 160 }}>{cloneElement(children, { width: 400, height: 160 } as object)}</div>
    ),
  };
});

import { SystemMonitorView } from './sistem/system-view';
import { NotificationsOpsView } from './bildirimler/notifications-view';
import PlansPage from './paketler/page';
import SettingsPage from './ayarlar/page';
import AuditPage from './denetim/page';
import { SystemLogsView } from './loglar/system-logs-view';
import { JsonDiff } from '@/components/admin/json-diff';

beforeEach(() => {
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
});

const counts = (over: Record<string, number> = {}) => ({
  waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, prioritized: 0, paused: 0, ...over,
});
const queuesFixture = [
  { name: 'scrape', isPaused: false, counts: counts({ waiting: 3, failed: 4, completed: 120 }) },
  { name: 'analyze', isPaused: false, counts: counts({ waiting: 1200, active: 4 }) },
  { name: 'match', isPaused: false, counts: counts() },
  { name: 'notify', isPaused: false, counts: counts({ failed: 2 }) },
  { name: 'notify-telegram', isPaused: true, counts: counts() },
];
const workersFixture = [
  { host: 'w-1', pid: 101, role: 'worker', startedAt: '2026-10-11T06:00:00.000Z', lastSeenAt: '2026-10-11T09:59:50.000Z', alive: true },
  { host: 'w-2', pid: 202, role: 'scheduler', startedAt: '2026-10-10T06:00:00.000Z', lastSeenAt: '2026-10-11T07:00:00.000Z', alive: false },
];
const pct = (p50: number | null, p95: number | null, n: number) => ({ p50, p95, n });
const latencyFixture = (range = '24h') => ({
  range,
  byReason: { NEW: pct(4200, 18400, 310), PRICE_DROP: pct(3100, 9000, 40), RELIST: pct(null, null, 0) },
  byChannel: { IN_APP: pct(900, 2400, 300), TELEGRAM: pct(5200, 21000, 50), EMAIL: pct(null, null, 0) },
});
const stuckFixture = {
  total: 1,
  items: [
    {
      analysisId: 12, listingId: 77, matchEvent: 'PRICE_DROP', matchDispatchAttempts: 10, createdAt: '2026-10-11T05:00:00.000Z',
      listing: { title: 'BMW 320i 2019', make: 'BMW', model: '3 Serisi', year: 2019, status: 'ACTIVE' },
    },
  ],
};

function systemHandlers(over: { queues?: () => Response } = {}) {
  return [
    meHandler('ADMIN'),
    http.get('*/api/v1/admin/queues', over.queues ?? (() => HttpResponse.json(queuesFixture))),
    http.get('*/api/v1/admin/workers', () => HttpResponse.json(workersFixture)),
    http.get('*/api/v1/admin/notifications/latency', ({ request }) =>
      HttpResponse.json(latencyFixture(new URL(request.url).searchParams.get('range') ?? '24h')),
    ),
    http.get('*/api/v1/admin/match-dispatches/stuck', () => HttpResponse.json(stuckFixture)),
  ];
}

describe('Sistem izleme', () => {
  it('shows queue counts, workers alive/dead and latency values', async () => {
    server.use(...systemHandlers());
    renderWithClient(<SystemMonitorView />);
    const scrape = await screen.findByRole('article', { name: 'Tarama' });
    expect(within(scrape).getByRole('group', { name: 'Başarısız' })).toHaveTextContent('4');
    expect(within(screen.getByRole('article', { name: 'Analiz' })).getByRole('group', { name: 'Bekleyen' })).toHaveTextContent('1.200');
    expect(within(screen.getByRole('article', { name: 'Telegram bildirimi' })).getByText('Duraklatıldı')).toBeInTheDocument();
    // Başarısız işi yoksa yeniden deneme kapalı.
    expect(within(screen.getByRole('article', { name: 'Eşleştirme' })).getByRole('button', { name: 'Başarısızları yeniden dene' })).toBeDisabled();

    const workers = await screen.findByRole('list', { name: "Worker'lar" });
    expect(within(workers).getByText('w-1')).toBeInTheDocument();
    expect(within(workers).getByText('Canlı')).toBeInTheDocument();
    expect(within(workers).getByText('Yanıt vermiyor')).toBeInTheDocument();

    const byReason = await screen.findByRole('table', { name: /Nedene göre gecikme/ });
    const newRow = within(byReason).getByRole('row', { name: /Yeni ilan/ });
    expect(newRow).toHaveTextContent('4,2 sn');
    expect(newRow).toHaveTextContent('18,4 sn');
    expect(within(byReason).getByRole('row', { name: /Yeniden yayın/ })).toHaveTextContent('—');
  });

  it('switches latency range to 7 days', async () => {
    const ranges: string[] = [];
    // server.use öne ekler; aynı çağrıda önce gelen işleyici kazanır.
    server.use(
      http.get('*/api/v1/admin/notifications/latency', ({ request }) => {
        const r = new URL(request.url).searchParams.get('range') ?? '';
        ranges.push(r);
        return HttpResponse.json(latencyFixture(r));
      }),
      ...systemHandlers(),
    );
    const user = userEvent.setup();
    renderWithClient(<SystemMonitorView />);
    await screen.findByRole('table', { name: /Nedene göre gecikme/ });
    await user.click(screen.getByRole('button', { name: 'Son 7 gün' }));
    await waitFor(() => expect(ranges).toContain('7d'));
    expect(screen.getByRole('button', { name: 'Son 7 gün' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('retries failed jobs after confirmation and reports retried/skipped', async () => {
    const calls: string[] = [];
    server.use(
      ...systemHandlers(),
      http.post('*/api/v1/admin/queues/:name/retry-failed', ({ params }) => {
        calls.push(String(params.name));
        return HttpResponse.json({ retried: 3, skipped: 1 });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SystemMonitorView />);
    const scrape = await screen.findByRole('article', { name: 'Tarama' });
    await user.click(within(scrape).getByRole('button', { name: 'Başarısızları yeniden dene' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Yeniden dene' }));
    await waitFor(() => expect(calls).toEqual(['scrape']));
    expect(toastMock.success).toHaveBeenCalledWith('Başarısız işler yeniden denendi', { description: '3 iş yeniden denendi, 1 iş atlandı.' });
  });

  it('cleans a queue with the chosen state and age', async () => {
    const bodies: unknown[] = [];
    server.use(
      ...systemHandlers(),
      http.post('*/api/v1/admin/queues/notify/clean', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ removed: 7 });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SystemMonitorView />);
    const notify = await screen.findByRole('article', { name: 'Bildirim' });
    await user.click(within(notify).getByRole('button', { name: 'Temizle' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Silinecek işler'), 'failed');
    await user.selectOptions(within(dialog).getByLabelText('Şundan eski'), '86400');
    await user.click(within(dialog).getByRole('button', { name: 'Temizle' }));
    await waitFor(() => expect(bodies).toEqual([{ state: 'failed', olderThanSec: 86400 }]));
    expect(toastMock.success).toHaveBeenCalledWith('Kuyruk temizlendi', { description: '7 iş silindi.' });
  });

  it('keeps the dialog open with a clear message when Redis is down (503)', async () => {
    server.use(
      ...systemHandlers(),
      http.post('*/api/v1/admin/queues/:name/retry-failed', () => apiError(503, 'INTERNAL', 'Kuyruk sunucusuna şu anda erişilemiyor')),
    );
    const user = userEvent.setup();
    renderWithClient(<SystemMonitorView />);
    const scrape = await screen.findByRole('article', { name: 'Tarama' });
    await user.click(within(scrape).getByRole('button', { name: 'Başarısızları yeniden dene' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Yeniden dene' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Kuyruk sunucusuna şu anda erişilemiyor/);
  });

  it('shows a Redis warning when queue counts cannot be read', async () => {
    server.use(...systemHandlers({ queues: () => apiError(503, 'INTERNAL', 'x') }));
    renderWithClient(<SystemMonitorView />);
    expect(await screen.findByText(/Kuyruk sayıları okunamadı/)).toBeInTheDocument();
  });

  it('lists stuck match dispatches and resets one after confirmation', async () => {
    const reset: string[] = [];
    server.use(
      ...systemHandlers(),
      http.post('*/api/v1/admin/match-dispatches/:id/reset', ({ params }) => {
        reset.push(String(params.id));
        return HttpResponse.json({ analysisId: 12, matchDispatchAttempts: 0 });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SystemMonitorView />);
    expect(await screen.findByText('BMW 320i 2019')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Analiz #12 için sayacı sıfırla' }));
    const dialog = await screen.findByRole('dialog');
    expect(reset).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Sayacı sıfırla' }));
    await waitFor(() => expect(reset).toEqual(['12']));
    expect(toastMock.success).toHaveBeenCalledWith('Sayaç sıfırlandı', expect.anything());
  });
});

// ---------------------------------------------------------------- bildirimler

const notif = (id: number, over: Record<string, unknown> = {}) => ({
  id, userId: 'u1', userEmail: 'ayse@ornek.test', userStatus: 'ACTIVE', kind: 'MATCH', channel: 'TELEGRAM', status: 'FAILED',
  attempts: 5, lastError: 'ETIMEDOUT', title: `İlan ${id}`, reason: 'NEW', createdAt: '2026-10-11T08:00:00.000Z',
  queuedAt: null, sentAt: null, latencyMs: null, ...over,
});

describe('Bildirimler', () => {
  it('sends filters as query params', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/notifications', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ total: 1, items: [notif(101)] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<NotificationsOpsView />);
    await screen.findByText('İlan 101');
    await user.selectOptions(screen.getByLabelText('Durum'), 'FAILED');
    await waitFor(() => expect(seen.at(-1)!.get('status')).toBe('FAILED'));
    await user.selectOptions(screen.getByLabelText('Kanal'), 'TELEGRAM');
    await waitFor(() => expect(seen.at(-1)!.get('channel')).toBe('TELEGRAM'));
    expect(seen.at(-1)!.get('page')).toBe('1');
  });

  it('retries the selected FAILED rows and shows retried and skipped results', async () => {
    const bodies: unknown[] = [];
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/notifications', () =>
        HttpResponse.json({ total: 3, items: [notif(101), notif(102), notif(103, { status: 'SENT', lastError: null })] }),
      ),
      http.post('*/api/v1/admin/notifications/retry', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ retried: [101], skipped: [{ id: 102, reason: 'USER_INACTIVE' }] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<NotificationsOpsView />);
    await screen.findByText('İlan 101');
    expect(screen.getByRole('button', { name: /Seçilenleri yeniden dene/ })).toBeDisabled();
    // Yalnızca başarısız satırlar seçilebilir.
    expect(screen.getByRole('checkbox', { name: 'Bildirim #103 seç' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Bildirim #101 seç' }));
    await user.click(screen.getByRole('checkbox', { name: 'Bildirim #102 seç' }));
    await user.click(screen.getByRole('button', { name: 'Seçilenleri yeniden dene (2)' }));
    await waitFor(() => expect(bodies).toEqual([{ ids: [101, 102] }]));
    const result = await screen.findByRole('status', { name: 'Yeniden deneme sonucu' });
    expect(result).toHaveTextContent('1 bildirim yeniden kuyruğa alındı');
    expect(result).toHaveTextContent('1 bildirim atlandı');
    expect(within(result).getByText('#102')).toBeInTheDocument();
    expect(result).toHaveTextContent('Kullanıcı aktif değil');
  });
});

// ---------------------------------------------------------------- paketler

describe('Paketler', () => {
  it('renders the 404 view for ADMIN', async () => {
    server.use(meHandler('ADMIN'));
    renderWithClient(<PlansPage />);
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
  });

  it('locks IN_APP and the code; PATCH carries the new limits and warns about users over the limit', async () => {
    const bodies: unknown[] = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/plans', () => HttpResponse.json(plansFixture)),
      http.patch('*/api/v1/admin/plans/p-pro', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ plan: { ...plansFixture.items[1], usersOverProfileLimit: 3 } });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<PlansPage />);
    await user.click(await screen.findByRole('button', { name: 'PRO paketini düzenle' }));
    const dialog = await screen.findByRole('dialog', { name: /Paketi düzenle/ });
    const inApp = within(dialog).getByRole('checkbox', { name: /Uygulama içi/ });
    expect(inApp).toBeChecked();
    expect(inApp).toBeDisabled();
    expect(within(dialog).getByLabelText('Paket kodu')).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /Telegram/ }));
    const max = within(dialog).getByLabelText('Arama profili sınırı');
    await user.clear(max);
    await user.type(max, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Paketi kaydet' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      name: 'Pro',
      priceMonthly: 299,
      isActive: true,
      limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 200, channels: ['IN_APP'], opportunitiesDelayHours: 0 },
    });
    expect(await screen.findByText(/3 kullanıcının aktif arama profili sayısı yeni sınırı aşıyor/)).toBeInTheDocument();
  });

  it('FREE cannot be deactivated and a 409 is shown in the form', async () => {
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/plans', () => HttpResponse.json(plansFixture)),
      http.patch('*/api/v1/admin/plans/p-free', () => apiError(409, 'INVALID_OPERATION', 'FREE paketi pasifleştirilemez')),
    );
    const user = userEvent.setup();
    renderWithClient(<PlansPage />);
    await user.click(await screen.findByRole('button', { name: 'FREE paketini düzenle' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /Yeni aboneliklere açık/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Paketi kaydet' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('FREE paketi pasifleştirilemez');
  });

  it('creates a plan with IN_APP always included and maps 400 field errors', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/plans', () => HttpResponse.json(plansFixture)),
      http.post('*/api/v1/admin/plans', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return apiError(400, 'VALIDATION_FAILED', 'x', [{ path: 'limits.maxNotificationsPerDay', message: 'En fazla 100000' }]);
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<PlansPage />);
    await user.click(await screen.findByRole('button', { name: 'Yeni paket' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni paket' });
    await user.type(within(dialog).getByLabelText('Paket kodu'), 'GOLD');
    await user.type(within(dialog).getByLabelText('Ad'), 'Altın');
    await user.type(within(dialog).getByLabelText('Aylık fiyat (₺)'), '499');
    await user.type(within(dialog).getByLabelText('Arama profili sınırı'), '20');
    await user.type(within(dialog).getByLabelText('Günlük bildirim sınırı'), '999999');
    await user.type(within(dialog).getByLabelText('Fırsat gecikmesi (saat)'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Paketi oluştur' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ code: 'GOLD', limits: { channels: ['IN_APP'] } });
    expect(await within(dialog).findByText('En fazla 100000')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Günlük bildirim sınırı')).toHaveAttribute('aria-invalid', 'true');
  });
});

// ---------------------------------------------------------------- ayarlar

const DEFAULT_ANALYSIS = {
  minComparables: 5, yearAdjPct: 0.07, kmAdjPer10k: 0.02, maxAdjPct: 0.2, theilSenMinPool: 8, smallPoolMax: 7,
  dispersionThreshold: 0.25, suspiciousDiscount: 0.45, poolWindowDays: 60, refreshMinChangePct: 0.02,
};
const DEFAULT_ALERTS = { notifyQueueDepth: 500, notifyFailureRate: 0.1, parserErrorRate: 0.2, heartbeatMissSec: 60 };

function settingsFixture(analysisValue: Record<string, unknown> | null = null, effective?: Record<string, unknown>) {
  return {
    items: [
      {
        key: 'analysis.settings', value: analysisValue, updatedAt: analysisValue ? '2026-10-10T00:00:00.000Z' : null,
        defaults: DEFAULT_ANALYSIS, effective: effective ?? { ...DEFAULT_ANALYSIS, ...(analysisValue ?? {}) },
      },
      { key: 'alerts.thresholds', value: null, updatedAt: null, defaults: DEFAULT_ALERTS, effective: DEFAULT_ALERTS },
    ],
  };
}

describe('Ayarlar', () => {
  it('renders the 404 view for ADMIN', async () => {
    server.use(meHandler('ADMIN'));
    renderWithClient(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
  });

  it('shows the cross-field error client-side and does not send the request', async () => {
    const patches: unknown[] = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/settings', () => HttpResponse.json(settingsFixture())),
      http.patch('*/api/v1/admin/settings', async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SettingsPage />);
    const form = await screen.findByRole('form', { name: 'Analiz katsayıları' });
    const small = within(form).getByLabelText('Küçük havuz sınırı');
    await user.clear(small);
    await user.type(small, '3');
    await user.click(within(form).getByRole('button', { name: 'Analiz katsayılarını kaydet' }));
    expect(await within(form).findByText('Bu değer en az emsal sayısından küçük olamaz.')).toBeInTheDocument();
    expect(small).toHaveAttribute('aria-invalid', 'true');
    expect(patches).toHaveLength(0);
  });

  it('sends only changed fields and maps a 400 error to the field', async () => {
    const patches: unknown[] = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/settings', () => HttpResponse.json(settingsFixture())),
      http.patch('*/api/v1/admin/settings', async ({ request }) => {
        patches.push(await request.json());
        return apiError(400, 'VALIDATION_FAILED', 'x', [{ path: 'value.poolWindowDays', message: 'Sunucu: aralık dışı' }]);
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SettingsPage />);
    const form = await screen.findByRole('form', { name: 'Analiz katsayıları' });
    const win = within(form).getByLabelText('Havuz penceresi (gün)');
    await user.clear(win);
    await user.type(win, '90');
    await user.click(within(form).getByRole('button', { name: 'Analiz katsayılarını kaydet' }));
    await waitFor(() => expect(patches).toEqual([{ key: 'analysis.settings', value: { poolWindowDays: 90 } }]));
    expect(await within(form).findByText('Sunucu: aralık dışı')).toBeInTheDocument();
    expect(win).toHaveAttribute('aria-invalid', 'true');
  });

  it('flags an invalid stored value and lets the admin reset the field to its default (null)', async () => {
    const patches: unknown[] = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      // Kayıtlı smallPoolMax (2) < minComparables (5): motor varsayılanları kullanıyor.
      http.get('*/api/v1/admin/settings', () => HttpResponse.json(settingsFixture({ smallPoolMax: 2 }, DEFAULT_ANALYSIS))),
      http.patch('*/api/v1/admin/settings', async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ setting: settingsFixture().items[0] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SettingsPage />);
    const form = await screen.findByRole('form', { name: 'Analiz katsayıları' });
    expect(within(form).getByRole('alert')).toHaveTextContent(/Kayıtlı değer geçersiz/);
    expect(within(form).getByLabelText('Küçük havuz sınırı')).toHaveValue('2');
    await user.click(within(form).getByRole('button', { name: 'Küçük havuz sınırı: varsayılana dön' }));
    await user.click(within(form).getByRole('button', { name: 'Analiz katsayılarını kaydet' }));
    await waitFor(() => expect(patches).toEqual([{ key: 'analysis.settings', value: { smallPoolMax: null } }]));
    expect(toastMock.success).toHaveBeenCalledWith('Analiz katsayıları kaydedildi');
  });

  it('saves alert thresholds with decimal comma input', async () => {
    const patches: unknown[] = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/settings', () => HttpResponse.json(settingsFixture())),
      http.patch('*/api/v1/admin/settings', async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ setting: settingsFixture().items[1] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SettingsPage />);
    const form = await screen.findByRole('form', { name: 'Alarm eşikleri' });
    const rate = within(form).getByLabelText('Bildirim hata oranı');
    await user.clear(rate);
    await user.type(rate, '0,25');
    await user.click(within(form).getByRole('button', { name: 'Alarm eşiklerini kaydet' }));
    await waitFor(() => expect(patches).toEqual([{ key: 'alerts.thresholds', value: { notifyFailureRate: 0.25 } }]));
  });
});

// ---------------------------------------------------------------- denetim

const auditRow = (over: Record<string, unknown> = {}) => ({
  id: 1, action: 'user.suspend',
  actor: { id: 'a1', email: 'yonetici@oto.test', name: 'Deniz', role: 'SUPER_ADMIN', status: 'ACTIVE' },
  targetType: 'User', targetId: 'u1', before: { status: 'ACTIVE', name: 'Ayşe' }, after: { status: 'SUSPENDED', name: 'Ayşe' },
  ip: '10.0.0.1', createdAt: '2026-10-11T08:00:00.000Z', ...over,
});

describe('Denetim', () => {
  it('renders the 404 view for ADMIN', async () => {
    server.use(meHandler('ADMIN'));
    renderWithClient(<AuditPage />);
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
  });

  it('shows a before/after diff of changed fields and sends filters', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      meHandler('SUPER_ADMIN'),
      http.get('*/api/v1/admin/audit-logs', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ total: 1, items: [auditRow()] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AuditPage />);
    expect(await screen.findByText('user.suspend')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Değişiklikleri göster' }));
    const diff = screen.getByRole('table', { name: /Önce ve sonra/ });
    const row = within(diff).getByRole('row', { name: /status/ });
    expect(row).toHaveTextContent('"ACTIVE"');
    expect(row).toHaveTextContent('"SUSPENDED"');
    expect(row).toHaveTextContent('Değişti');
    expect(within(diff).queryByRole('row', { name: /name/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Değişmeyen 1 alanı göster/ }));
    expect(within(diff).getByRole('row', { name: /name/ })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Eylem'), 'plan');
    await waitFor(() => expect(seen.at(-1)!.get('action')).toBe('plan'));
  });
});

describe('JsonDiff', () => {
  it('renders redacted sides clearly and never injects HTML', () => {
    renderWithClient(<JsonDiff before={{ redacted: true }} after={{ note: '<img src=x onerror=alert(1)>' }} />);
    expect(screen.getByText(/gizlendi/)).toBeInTheDocument();
    expect(screen.getByText('"<img src=x onerror=alert(1)>"')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('marks added and removed fields', () => {
    renderWithClient(<JsonDiff before={{ a: 1, nested: { x: true } }} after={{ b: 2, nested: { x: false } }} />);
    const t = screen.getByRole('table', { name: /Önce ve sonra/ });
    expect(within(t).getByRole('row', { name: /^a/ })).toHaveTextContent('Kaldırıldı');
    expect(within(t).getByRole('row', { name: /^b/ })).toHaveTextContent('Eklendi');
    expect(within(t).getByRole('row', { name: /nested\.x/ })).toHaveTextContent('Değişti');
  });
});

// ---------------------------------------------------------------- sistem logları

describe('Sistem logları', () => {
  it('filters by level and shows context JSON as text', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/system-logs', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          total: 1,
          items: [
            { id: 5, level: 'ERROR', component: 'monitor', message: '<b>Kaynak çalışmıyor</b>', context: { sourceId: 2, token: '[gizli]' }, createdAt: '2026-10-11T08:00:00.000Z' },
          ],
        });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<SystemLogsView />);
    expect(await screen.findByText('<b>Kaynak çalışmıyor</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Seviye'), 'ERROR');
    await waitFor(() => expect(seen.at(-1)!.get('level')).toBe('ERROR'));
    await user.click(screen.getByRole('button', { name: 'Bağlamı göster' }));
    expect(screen.getByText(/"sourceId": 2/)).toBeInTheDocument();
  });
});
