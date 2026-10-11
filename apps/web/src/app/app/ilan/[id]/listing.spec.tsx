import { cloneElement } from 'react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListingDetail } from '@oto/shared';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

let paramId = '10';
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: paramId }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/ilan/10',
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

import ListingPage from './page';

const comp = (id: number, over: Partial<ListingDetail['comparables'][number]> = {}) => ({
  id,
  title: `Emsal ${id}`,
  city: 'Ankara',
  url: `https://example.com/${id}`,
  year: 2019,
  km: 85000,
  price: '1150000',
  adjusted: '1180000',
  damaged: false,
  outlier: false,
  clamped: false,
  status: 'ACTIVE' as const,
  ...over,
});

function detail(over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: 10,
    title: 'Sahibinden temiz BMW',
    make: 'BMW',
    model: '3 Serisi',
    trim: '320i',
    year: 2019,
    km: 80000,
    fuel: 'GASOLINE',
    transmission: 'AUTOMATIC',
    city: 'İstanbul',
    price: '960000',
    imageUrl: null,
    url: 'https://example.com/ilan/10',
    status: 'ACTIVE',
    firstSeenAt: '2026-10-01T10:00:00.000Z',
    lastSeenAt: '2026-10-10T10:00:00.000Z',
    removedAt: null,
    isFavorite: false,
    bodyType: 'Sedan',
    color: 'Siyah',
    sellerType: 'Sahibinden',
    damageInfo: { tramerAmount: 12000, paintedParts: ['Kaput'], changedParts: [] },
    priceHistory: [
      { price: '1000000', km: 80000, observedAt: '2026-10-01T10:00:00.000Z' },
      { price: '960000', km: 80000, observedAt: '2026-10-05T10:00:00.000Z' },
    ],
    analysis: {
      opportunityScore: 77,
      confidence: 'HIGH',
      estimatedPrice: '1200000',
      priceDiff: '240000',
      discountPct: 0.2,
      comparableCount: 14,
      band: { q1: '1100000', median: '1200000', q3: '1300000' },
      flags: [],
      insufficientReason: 'NONE',
    },
    explanation: {
      level: 1,
      insufficientReason: 'NONE',
      pool: { used: 3, outlierIds: [102], damagedExcluded: 99 },
      adjustments: { kmMethod: 'THEIL_SEN', yearAdjPct: 0.07 },
      confidenceSteps: ['Seviye tavanı: HIGH', 'Yayılım düşük'],
      flags: [],
    },
    comparables: [comp(101), comp(102, { outlier: true, damaged: true }), comp(103, { clamped: true }), comp(104, { damaged: true })],
    myMatches: [
      { id: 1, reason: 'PRICE_DROP', matchedPrice: '960000', createdAt: '2026-10-05T10:00:00.000Z', profile: { id: 'p1', name: 'Günlük araç' } },
    ],
    ...over,
  };
}

function mockDetail(d: ListingDetail | 404) {
  server.use(
    http.get('*/api/v1/me/listings/:id', () =>
      d === 404
        ? HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'yok' } }, { status: 404 })
        : HttpResponse.json(d),
    ),
  );
}

beforeEach(() => {
  paramId = '10';
});

describe('İlan detayı', () => {
  it('alanları ve fiyat bandını gösterir', async () => {
    mockDetail(detail());
    renderWithClient(<ListingPage />);
    expect(await screen.findByRole('heading', { level: 1, name: /BMW 3 Serisi 320i/ })).toBeInTheDocument();
    expect(screen.getAllByText(/960\.000\s₺/).length).toBeGreaterThan(0);
    expect(screen.getByText('80.000 km')).toBeInTheDocument();
    expect(screen.getByText('Sedan')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Fiyat bandı/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Fırsat skoru 77/100' })).toBeInTheDocument();
    expect(screen.getByText('Günlük araç')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /İlana git/ })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('INSUFFICIENT analizde Zayıf tahmin ve sebep görünür', async () => {
    mockDetail(
      detail({
        analysis: {
          opportunityScore: 0,
          confidence: 'INSUFFICIENT',
          estimatedPrice: null,
          priceDiff: null,
          discountPct: null,
          comparableCount: 0,
          band: { q1: null, median: null, q3: null },
          flags: [],
          insufficientReason: 'NO_LEVEL',
        },
        explanation: { level: 3, insufficientReason: 'NO_LEVEL', pool: { used: 0, outlierIds: [] } },
        comparables: [],
      }),
    );
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByText(/Zayıf tahmin/).length).toBeGreaterThan(0);
    expect(screen.getByRole('note')).toHaveTextContent('yeterli benzer ilan yok');
  });

  it('REMOVED ilan rozetiyle açılır', async () => {
    mockDetail(detail({ status: 'REMOVED', removedAt: '2026-10-09T10:00:00.000Z' }));
    renderWithClient(<ListingPage />);
    expect(await screen.findByText('Yayından kalktı')).toBeInTheDocument();
  });

  it('açıklama panelinde emsal satırları, uç değer rozeti ve türetilmiş hasar sayıları', async () => {
    mockDetail(detail());
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { name: 'Fiyat nasıl hesaplandı?' });
    expect(screen.getAllByTestId('comparable-row')).toHaveLength(4);
    expect(screen.getByText('uç değer')).toBeInTheDocument();
    expect(screen.getByText('sınırlandı')).toBeInTheDocument();
    expect(screen.getByText(/±1 yıl, ±%25 km/)).toBeInTheDocument();
    expect(screen.getByText('Theil–Sen eğimi')).toBeInTheDocument();
    expect(screen.getByText('Seviye tavanı: HIGH')).toBeInTheDocument();
    // türetilmiş: 1 hasarlı uç değer dışlandı, 1 hasarlı kullanıldı; pool.damagedExcluded (99) gösterilmez
    const excluded = screen.getByText('Hasarlı olup dışlanan').nextElementSibling as HTMLElement;
    const used = screen.getByText('Hasarlı olup kullanılan').nextElementSibling as HTMLElement;
    expect(within(excluded).getByText('1')).toBeInTheDocument();
    expect(within(used).getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
  });

  it('404 yanıtında bulunamadı görünümü', async () => {
    mockDetail(404);
    renderWithClient(<ListingPage />);
    expect(await screen.findByText('İlan bulunamadı')).toBeInTheDocument();
  });

  it('sayısal olmayan id bulunamadı gösterir', async () => {
    paramId = 'abc';
    renderWithClient(<ListingPage />);
    expect(await screen.findByText('İlan bulunamadı')).toBeInTheDocument();
  });

  it('favori geçişi istek gönderir', async () => {
    mockDetail(detail());
    let method = '';
    server.use(
      http.put('*/api/v1/me/favorites/10', () => {
        method = 'PUT';
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<ListingPage />);
    const btn = await screen.findByRole('button', { name: /favori/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await vi.waitFor(() => expect(method).toBe('PUT'));
  });
});
