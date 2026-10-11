import { cloneElement } from 'react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { apiError, meHandler } from '@/test/admin-fixtures';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/ilanlar',
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

import { AdminListingsView } from './listings-view';
import { AdminListingDetailView } from './[id]/listing-detail-view';
import { AdminAnalysesView } from '../analizler/analyses-view';

beforeEach(() => {
  toastMock.error.mockClear();
  toastMock.success.mockClear();
});

const summary = (over: Record<string, unknown> = {}) => ({
  opportunityScore: 78,
  confidence: 'HIGH',
  estimatedPrice: '1100000',
  priceDiff: '120000',
  discountPct: 0.11,
  comparableCount: 14,
  band: { q1: '1000000', median: '1100000', q3: '1200000' },
  flags: [],
  insufficientReason: 'NONE',
  ...over,
});

const card = (over: Record<string, unknown> = {}) => ({
  id: 42,
  title: 'Renault Clio 1.0 TCe Touch',
  make: 'Renault',
  model: 'Clio',
  trim: 'Touch',
  year: 2021,
  km: 48000,
  fuel: 'GASOLINE',
  transmission: 'MANUAL',
  city: 'İzmir',
  price: '980000',
  imageUrl: null,
  url: 'https://demo.example/ilan/42',
  status: 'ACTIVE',
  firstSeenAt: '2026-10-09T08:00:00.000Z',
  analysis: summary(),
  isFavorite: false,
  ...over,
});

const detail = (latestAnalysisId: number | null, over: Record<string, unknown> = {}) => ({
  listing: {
    ...card(),
    sourceId: 1,
    sourceCode: 'demo-site',
    externalId: 'D-42',
    bodyType: 'Hatchback',
    color: 'Beyaz',
    sellerType: 'Galeri',
    damageInfo: null,
    currency: 'TRY',
    lastSeenAt: '2026-10-11T08:00:00.000Z',
    removedAt: null,
    relistedAt: null,
    latestAnalysisId,
    matchCount: 3,
    ...over,
  },
  analyses: latestAnalysisId
    ? [
        { id: latestAnalysisId, createdAt: '2026-10-10T08:00:00.000Z', engineVersion: 'v1.3', matchEvent: 'NEW', listingPrice: '980000', ...summary() },
        { id: 3, createdAt: '2026-10-09T08:00:00.000Z', engineVersion: 'v1.2', matchEvent: null, listingPrice: '1010000', ...summary({ opportunityScore: 61, confidence: 'MEDIUM' }) },
      ]
    : [],
  priceHistory: [
    { price: '1010000', km: 47000, observedAt: '2026-10-09T08:00:00.000Z' },
    { price: '980000', km: 48000, observedAt: '2026-10-10T08:00:00.000Z' },
  ],
  issues: [],
});

const analysisDetail = (id: number) => ({
  analysis: {
    id,
    listingId: 42,
    title: 'Renault Clio 1.0 TCe Touch',
    make: 'Renault',
    model: 'Clio',
    year: 2021,
    engineVersion: 'v1.3',
    expansionLevel: 1,
    matchEvent: 'NEW',
    listingPrice: '980000',
    createdAt: '2026-10-10T08:00:00.000Z',
    comparableIds: [7, 8],
    explanation: {
      level: 1,
      comparables: [
        { id: 7, price: 1050000, year: 2021, km: 40000, damaged: false, adjusted: 1060000, clamped: false, outlier: false },
        { id: 8, price: 1150000, year: 2020, km: 52000, damaged: false, adjusted: 1140000, clamped: false, outlier: false },
      ],
      confidenceSteps: ['level-cap:HIGH'],
      pool: { used: 2, outlierIds: [] },
      adjustments: { kmMethod: 'DEFAULT', kmAdjPer10k: 0.02 },
      flags: [],
    },
    ...summary(),
  },
});

describe('listings table', () => {
  it('sends filters and switches to the issues tab', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/sources', () => HttpResponse.json({ total: 1, items: [{ id: 1, code: 'demo-site', name: 'Demo site' }] })),
      http.get('*/api/v1/admin/listings', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ total: 1, items: [{ ...card(), sourceId: 1, sourceCode: 'demo-site', issueCount: 2 }] });
      }),
      http.get('*/api/v1/admin/listing-issues', () =>
        HttpResponse.json({
          total: 1,
          items: [
            { id: 9, sourceId: 1, sourceCode: 'demo-site', listingId: null, externalId: 'D-99', field: 'price', problem: 'fiyat okunamadı', rawSnippet: '<b>?</b>', createdAt: '2026-10-11T07:00:00.000Z' },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminListingsView />);
    expect(await screen.findByText('Renault Clio 1.0 TCe Touch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Renault Clio 1.0 TCe Touch' })).toHaveAttribute('href', '/admin/ilanlar/42');

    await user.selectOptions(screen.getByLabelText('Durum'), 'REMOVED');
    await waitFor(() => expect(seen.at(-1)!.get('status')).toBe('REMOVED'));
    await user.selectOptions(screen.getByLabelText('Sorun kaydı'), 'true');
    await waitFor(() => expect(seen.at(-1)!.get('hasIssues')).toBe('true'));
    await user.type(screen.getByRole('searchbox', { name: 'Başlıkta ara' }), 'clio');
    await waitFor(() => expect(seen.at(-1)!.get('q')).toBe('clio'));

    await user.click(screen.getByRole('tab', { name: 'Sorunlu kayıtlar' }));
    expect(await screen.findByText('fiyat okunamadı')).toBeInTheDocument();
    expect(screen.getByText('D-99')).toBeInTheDocument();
  });
});

describe('analyses table', () => {
  it('lists analyses and filters by confidence', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get('*/api/v1/admin/analyses', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          total: 1,
          items: [{ id: 5, listingId: 42, title: 'Renault Clio 1.0 TCe Touch', make: 'Renault', model: 'Clio', year: 2021, engineVersion: 'v1.3', matchEvent: 'NEW', createdAt: '2026-10-10T08:00:00.000Z', ...summary() }],
        });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminAnalysesView />);
    expect(await screen.findByRole('link', { name: 'Renault Clio 1.0 TCe Touch' })).toHaveAttribute('href', '/admin/ilanlar/42');
    await user.selectOptions(screen.getByLabelText('Güven'), 'LOW');
    await waitFor(() => expect(seen.at(-1)!.get('confidence')).toBe('LOW'));
  });
});

describe('listing detail', () => {
  it('reanalyzes once, keeps the button disabled while waiting and reports the new analysis', async () => {
    let getCount = 0;
    let posts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/listings/42', () => {
        getCount += 1;
        return HttpResponse.json(posts > 0 ? detail(11) : detail(10));
      }),
      http.get('*/api/v1/admin/analyses/:id', ({ params }) => HttpResponse.json(analysisDetail(Number(params.id)))),
      http.post('*/api/v1/admin/listings/42/reanalyze', async () => {
        posts += 1;
        await gate;
        return HttpResponse.json({ jobId: 'analyze-manual-42-1' }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminListingDetailView id={42} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Renault Clio 1.0 TCe Touch' })).toBeInTheDocument();
    // Plan 06 bileşenleri: açıklama paneli ve analiz geçmişi
    expect(await screen.findByRole('heading', { name: 'Fiyat nasıl hesaplandı?' })).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Analiz geçmişi' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);

    const button = screen.getByRole('button', { name: 'Yeniden analiz et' });
    await user.click(button);
    // Bekleme durumunda devre dışı: ikinci tıklama istek göndermez
    const waiting = screen.getByRole('button', { name: /Analiz sırada/ });
    expect(waiting).toBeDisabled();
    await user.click(waiting);
    expect(posts).toBe(1);
    release();

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Yeniden analiz tamamlandı'));
    expect(posts).toBe(1);
    expect(getCount).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('status')).toHaveTextContent('Yeni analiz hazır');
    expect(screen.getByRole('button', { name: 'Yeniden analiz et' })).toBeEnabled();
  });

  it('shows the server reason when reanalyze is rejected and disables it for removed listings', async () => {
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/listings/42', () => HttpResponse.json(detail(10))),
      http.get('*/api/v1/admin/analyses/:id', ({ params }) => HttpResponse.json(analysisDetail(Number(params.id)))),
      http.post('*/api/v1/admin/listings/42/reanalyze', () => apiError(503, 'INTERNAL', 'Yeniden analiz şu anda kuyruğa alınamıyor')),
    );
    const user = userEvent.setup();
    const { unmount } = renderWithClient(<AdminListingDetailView id={42} />);
    await user.click(await screen.findByRole('button', { name: 'Yeniden analiz et' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('kuyruğa alınamıyor')));
    expect(screen.getByRole('button', { name: 'Yeniden analiz et' })).toBeEnabled();
    unmount();

    server.use(http.get('*/api/v1/admin/listings/42', () => HttpResponse.json(detail(10, { status: 'REMOVED', removedAt: '2026-10-11T06:00:00.000Z' }))));
    renderWithClient(<AdminListingDetailView id={42} />);
    expect(await screen.findByRole('button', { name: 'Yeniden analiz et' })).toBeDisabled();
    expect(screen.getByText('Kaldırılmış ilan yeniden analiz edilemez.')).toBeInTheDocument();
  });
});

describe('listing detail: reanalyze waiting', () => {
  afterEach(() => vi.useRealTimers());

  it('gives up after 90 seconds with an explanation and re-enables the button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gets = 0;
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/listings/42', () => {
        gets += 1;
        return HttpResponse.json(detail(10));
      }),
      http.get('*/api/v1/admin/analyses/:id', ({ params }) => HttpResponse.json(analysisDetail(Number(params.id)))),
      http.post('*/api/v1/admin/listings/42/reanalyze', () => HttpResponse.json({ jobId: 'analyze-manual-42-1' }, { status: 202 })),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithClient(<AdminListingDetailView id={42} />);
    await user.click(await screen.findByRole('button', { name: 'Yeniden analiz et' }));
    expect(await screen.findByRole('button', { name: /Analiz sırada/ })).toBeDisabled();
    const before = gets;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(gets).toBeGreaterThan(before); // bekleme sırasında yoklama
    await act(() => vi.advanceTimersByTimeAsync(81_000));
    expect(await screen.findByRole('status')).toHaveTextContent('Sonuç 90 saniyede gelmedi');
    expect(screen.getByRole('button', { name: 'Yeniden analiz et' })).toBeEnabled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('does not toast after the page is left while the request is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/listings/42', () => HttpResponse.json(detail(10))),
      http.get('*/api/v1/admin/analyses/:id', ({ params }) => HttpResponse.json(analysisDetail(Number(params.id)))),
      http.post('*/api/v1/admin/listings/42/reanalyze', async () => {
        await gate;
        return apiError(409, 'INVALID_OPERATION', 'Kaldırılmış ilan yeniden analiz edilemez');
      }),
    );
    const user = userEvent.setup();
    const { unmount } = renderWithClient(<AdminListingDetailView id={42} />);
    await user.click(await screen.findByRole('button', { name: 'Yeniden analiz et' }));
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
