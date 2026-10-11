import { cloneElement } from 'react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { apiError, meHandler } from '@/test/admin-fixtures';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/kaynaklar',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('recharts', async (orig) => {
  const mod = await orig<typeof import('recharts')>();
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 400, height: 160 }}>{cloneElement(children, { width: 400, height: 160 } as object)}</div>
    ),
  };
});

import { AdminSourcesView } from './sources-view';
import { AdminSourceDetailView } from './[id]/source-detail-view';

beforeEach(() => {
  toastMock.error.mockClear();
  toastMock.success.mockClear();
  toastMock.warning.mockClear();
});

const source = (over: Record<string, unknown> = {}) => ({
  id: 1,
  code: 'demo-site',
  name: 'Demo site',
  adapterKey: 'demo-site',
  kind: 'HTTP',
  permissionType: 'TEST',
  permissionNote: 'Yerel demo sitesi; kendi sunucumuz.',
  permissionVerifiedAt: '2026-10-01T09:00:00.000Z',
  isActive: true,
  intervalSec: 300,
  maxConcurrency: 1,
  minRequestGapMs: 1000,
  config: { baseUrl: 'http://127.0.0.1:4010/ilanlar?…', pages: 3 },
  proxyConfigId: null,
  health: 'HEALTHY',
  lastSuccessAt: '2026-10-11T09:00:00.000Z',
  lastErrorAt: null,
  consecutiveFailures: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-11T09:00:00.000Z',
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  ...source(over),
  last24h: { jobs: { total: 12, succeeded: 11, failed: 1, partial: 0 }, listings: { new: 140, updated: 380, removed: 22 } },
});

const stats = {
  jobs: { total: 12, succeeded: 11, failed: 1, partial: 0 },
  listingsPerDay: [
    { day: '2026-10-10', new: 120, updated: 300, removed: 18 },
    { day: '2026-10-11', new: 140, updated: 380, removed: 22 },
  ],
  errorRate: 0.083,
  avgResponseMs: 420,
  errorsByKind: { PARSE: 3, FETCH: 1 },
};

function detailHandlers(src = source()) {
  return [
    meHandler('ADMIN'),
    http.get('*/api/v1/admin/sources/1', () => HttpResponse.json({ source: src })),
    http.get('*/api/v1/admin/sources/1/stats', () => HttpResponse.json(stats)),
    http.get('*/api/v1/admin/proxies', () =>
      HttpResponse.json({ total: 1, items: [{ id: 3, name: 'Çıkış A', url: 'http://***@proxy.example:8080', isEnabled: true, lastCheckAt: null, lastLatencyMs: null, lastError: null, sourceCount: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }] }),
    ),
  ];
}

describe('sources list', () => {
  it('explains why a source without verified permission cannot be activated', async () => {
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/sources', () =>
        HttpResponse.json({
          total: 2,
          items: [
            row(),
            row({ id: 2, code: 'partner-feed', name: 'Partner akışı', isActive: false, health: 'PAUSED', permissionVerifiedAt: null, consecutiveFailures: 4, lastSuccessAt: null }),
          ],
        }),
      ),
    );
    renderWithClient(<AdminSourcesView />);
    const card = (await screen.findByRole('heading', { name: 'Partner akışı' })).closest('article')!;
    const activate = within(card as HTMLElement).getByRole('button', { name: 'Etkinleştir' });
    expect(activate).toBeDisabled();
    expect(within(card as HTMLElement).getByText(/İzin doğrulanmadı/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('4')).toBeInTheDocument();

    const demo = screen.getByRole('heading', { name: 'Demo site' }).closest('article')!;
    expect(within(demo as HTMLElement).getByText('Sağlıklı')).toBeInTheDocument();
    expect(within(demo as HTMLElement).getByRole('button', { name: 'Duraklat' })).toBeEnabled();
  });

  it('shows the server reason when activation is refused', async () => {
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/sources', () => HttpResponse.json({ total: 1, items: [row({ isActive: false, health: 'PAUSED' })] })),
      http.post('*/api/v1/admin/sources/1/activate', () => apiError(409, 'INVALID_OPERATION', 'İzin doğrulanmadan kaynak etkinleştirilemez')),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminSourcesView />);
    await user.click(await screen.findByRole('button', { name: 'Etkinleştir' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('İzin doğrulanmadan kaynak etkinleştirilemez'));
  });
});

describe('source detail: test scrape', () => {
  it('shows the per-minute limit message on 429', async () => {
    server.use(
      ...detailHandlers(),
      http.post('*/api/v1/admin/sources/1/test-scrape', () => apiError(429, 'RATE_LIMITED', 'limit')),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminSourceDetailView id={1} />);
    await user.click(await screen.findByRole('button', { name: 'Test taraması başlat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('dakikada en fazla 1 test taraması');
  });

  it('starts a dry run and previews the result table', async () => {
    let body: unknown;
    let jobCalls = 0;
    server.use(
      ...detailHandlers(),
      http.post('*/api/v1/admin/sources/1/test-scrape', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ jobId: 77 }, { status: 202 });
      }),
      http.get('*/api/v1/admin/jobs/77', () => {
        jobCalls += 1;
        return HttpResponse.json({
          job: {
            id: 77, sourceId: 1, sourceCode: 'demo-site', sourceName: 'Demo site', trigger: 'MANUAL', dryRun: true,
            status: 'SUCCEEDED', startedAt: '2026-10-11T09:00:00.000Z', finishedAt: '2026-10-11T09:00:04.000Z',
            pagesFetched: 2, listingsSeen: 21, listingsNew: 0, listingsUpdated: 0, listingsRemoved: 0, errorsCount: 1,
            avgResponseMs: 300, errorSummary: null, createdAt: '2026-10-11T09:00:00.000Z', errors: [],
            dryRunResult: {
              pages: 2,
              durationMs: 4100,
              items: [
                { externalId: 'D-1', url: 'http://127.0.0.1:4010/ilan/1?…', title: 'Fiat Egea 1.4 Fire Easy', make: 'Fiat', model: 'Egea', year: 2020, km: 61000, price: '845000', city: 'Bursa' },
                { externalId: 'D-2', url: 'http://127.0.0.1:4010/ilan/2', title: 'Toyota Corolla 1.5 Vision', make: 'Toyota', model: 'Corolla', year: 2022, km: 30500, price: '1325000', city: null },
              ],
              problems: [{ externalId: 'D-3', field: 'year', problem: 'yıl aralık dışında', rawSnippet: '<td>1890</td>' }],
            },
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminSourceDetailView id={1} />);
    await user.click(await screen.findByRole('button', { name: 'Test taraması başlat' }));
    expect(body).toEqual({ dryRun: true });
    const table = await screen.findByRole('table', { name: /Dry-run önizlemesi/ });
    expect(within(table).getByText('Fiat Egea 1.4 Fire Easy')).toBeInTheDocument();
    expect(within(table).getByText(/^845\.000\s₺$/)).toBeInTheDocument();
    expect(within(table).getByText('Toyota Corolla 1.5 Vision')).toBeInTheDocument();
    expect(screen.getByText('yıl aralık dışında')).toBeInTheDocument();
    expect(jobCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('source detail: edit form', () => {
  it('does not send the masked config back when only other fields change', async () => {
    let patch: Record<string, unknown> | undefined;
    server.use(
      ...detailHandlers(),
      http.patch('*/api/v1/admin/sources/1', async ({ request }) => {
        patch = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ source: source({ name: 'Demo site (yerel)' }) });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminSourceDetailView id={1} />);
    const name = await screen.findByLabelText('Ad');
    await user.clear(name);
    await user.type(name, 'Demo site (yerel)');
    await user.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
    await waitFor(() => expect(patch).toEqual({ name: 'Demo site (yerel)' }));
    expect(toastMock.success).toHaveBeenCalledWith('Kaynak kaydedildi');
  });

  it('refuses to save a config that still carries the masked address', async () => {
    let patched = false;
    server.use(
      ...detailHandlers(),
      http.patch('*/api/v1/admin/sources/1', () => {
        patched = true;
        return HttpResponse.json({ source: source() });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminSourceDetailView id={1} />);
    const config = await screen.findByLabelText('Yapılandırma (JSON)');
    fireEvent.change(config, { target: { value: JSON.stringify({ baseUrl: 'http://127.0.0.1:4010/ilanlar?…', pages: 5 }, null, 2) } });
    await user.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
    expect(await screen.findByText(/maskeli/)).toBeInTheDocument();
    expect(patched).toBe(false);

    fireEvent.change(config, { target: { value: '{ "baseUrl": ' } });
    await user.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
    expect(await screen.findByText('Geçerli bir JSON nesnesi girin.')).toBeInTheDocument();
    expect(patched).toBe(false);
  });

  it('warns when revoking permission deactivates the source', async () => {
    let patch: Record<string, unknown> | undefined;
    server.use(
      ...detailHandlers(),
      http.patch('*/api/v1/admin/sources/1', async ({ request }) => {
        patch = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ source: source({ permissionVerifiedAt: null, isActive: false }) });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminSourceDetailView id={1} />);
    await user.click(await screen.findByRole('checkbox', { name: /İzin doğrulandı/ }));
    await user.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
    await waitFor(() => expect(patch).toEqual({ permissionVerified: false }));
    expect(toastMock.warning).toHaveBeenCalledWith('İzin geri alındı; kaynak devre dışı bırakıldı.');
  });
});
