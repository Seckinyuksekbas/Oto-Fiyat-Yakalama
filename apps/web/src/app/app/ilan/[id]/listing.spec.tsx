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

const raw = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  price: 1150000,
  year: 2019,
  km: 85000,
  damaged: false,
  adjusted: 1180000,
  clamped: false,
  outlier: false,
  ...over,
});

/** Motorun gerçek biçimi: hasarsız hedefte hasarlı emsaller listeye girmez, pool.damagedExcluded ayrı sayılır. */
function explanation(over: Record<string, unknown> = {}) {
  return {
    engineVersion: '1',
    level: 1,
    insufficient: false,
    insufficientReason: 'NONE',
    target: { price: 960000, year: 2019, km: 80000, trim: '320i', damaged: false },
    comparables: [raw(101), raw(102, { outlier: true }), raw(103, { clamped: true })],
    confidenceSteps: ['level-cap:HIGH', 'small-pool:MEDIUM', 'dispersion:-1'],
    pool: { candidates: 9, invalidPrice: 0, afterDedup: 9, inLevel: 6, damagedExcluded: 3, used: 2, outlierIds: [102] },
    adjustments: { yearAdjPct: 0.07, kmMethod: 'THEIL_SEN', kmSlopePerKm: -0.12, kmAdjPer10k: 0.02, maxAdjPct: 0.2 },
    stats: { q1: 1100000, median: 1200000, q3: 1300000, dispersion: 0.3 },
    flags: ['HIGH_DISPERSION'],
    ...over,
  };
}

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
    explanation: explanation(),
    comparables: [comp(101), comp(102, { outlier: true }), comp(103, { clamped: true })],
    myMatches: [
      { id: 1, reason: 'PRICE_DROP', matchedPrice: '960000', createdAt: '2026-10-05T10:00:00.000Z', profile: { id: 'p1', name: 'Günlük araç' } },
    ],
    ...over,
  };
}

const weakAnalysis = (reason: 'NO_LEVEL' | 'AFTER_OUTLIERS', withEstimate: boolean): ListingDetail['analysis'] => ({
  opportunityScore: 0,
  confidence: 'INSUFFICIENT',
  estimatedPrice: withEstimate ? '1200000' : null,
  priceDiff: withEstimate ? '240000' : null,
  discountPct: withEstimate ? 0.2 : null,
  comparableCount: 0,
  band: { q1: null, median: null, q3: null },
  flags: [],
  insufficientReason: reason,
});

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
        analysis: weakAnalysis('NO_LEVEL', false),
        explanation: explanation({
          insufficient: true,
          insufficientReason: 'NO_LEVEL',
          level: 3,
          comparables: [],
          confidenceSteps: ['insufficient:NO_LEVEL'],
          pool: { used: 0, outlierIds: [], damagedExcluded: 0 },
          flags: [],
        }),
        comparables: [],
      }),
    );
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByText(/Zayıf tahmin/).length).toBeGreaterThan(0);
    expect(screen.getByRole('note')).toHaveTextContent('yeterli benzer ilan yok');
    expect(screen.getByText('Denenen en geniş kapsam')).toBeInTheDocument();
    expect(screen.getByText(/Seviye 3/)).toBeInTheDocument();
  });

  it('REMOVED ilan rozetiyle açılır', async () => {
    mockDetail(detail({ status: 'REMOVED', removedAt: '2026-10-09T10:00:00.000Z' }));
    renderWithClient(<ListingPage />);
    expect(await screen.findByText(/Yayından kalktı · 09\.10\.2026/)).toBeInTheDocument();
    expect(screen.getByText(/kaynak bağlantısı artık çalışmayabilir/)).toBeInTheDocument();
  });

  it('hasarsız hedefte yalnızca hasarsız emsal kullanıldığını söyler ve pool.damagedExcluded gösterir', async () => {
    mockDetail(detail());
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { name: 'Fiyat nasıl hesaplandı?' });
    expect(screen.getAllByTestId('comparable-row')).toHaveLength(3);
    expect(screen.getAllByText('uç değer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('sınırlandı').length).toBeGreaterThan(0);
    expect(screen.getByText(/Seviye 1/)).toBeInTheDocument();
    expect(screen.getByText(/±1 yıl, ±%25 km/)).toBeInTheDocument();
    expect(screen.getByText(/Theil–Sen eğimi/)).toBeInTheDocument();
    expect(screen.getByText(/yalnızca hasarsız emsaller kullanıldı/)).toBeInTheDocument();
    const excluded = screen.getByText('Hesaba katılmayan hasarlı ilan').nextElementSibling as HTMLElement;
    expect(within(excluded).getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('Hasarlı olup dışlanan')).not.toBeInTheDocument();
  });

  it('hasarlı hedefte hesaba katılan hasarlı emsali ve uç değerdeki hasarlıyı gösterir', async () => {
    mockDetail(
      detail({
        comparables: [comp(101, { damaged: true }), comp(102, { outlier: true, damaged: true }), comp(103)],
        explanation: explanation({
          target: { price: 960000, year: 2019, km: 80000, trim: null, damaged: true },
          comparables: [raw(101, { damaged: true }), raw(102, { outlier: true, damaged: true }), raw(103)],
          flags: ['DAMAGED'],
          confidenceSteps: ['level-cap:HIGH', 'damaged:-1'],
        }),
      }),
    );
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { name: 'Fiyat nasıl hesaplandı?' });
    const used = screen.getByText('Hasarlı emsal (hesaba katılan)').nextElementSibling as HTMLElement;
    expect(within(used).getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/\(1'i hasarlı\)/)).toBeInTheDocument();
    expect(screen.queryByText(/yalnızca hasarsız emsaller kullanıldı/)).not.toBeInTheDocument();
    expect(screen.queryByText('Hesaba katılmayan hasarlı ilan')).not.toBeInTheDocument();
  });

  it('sayılar kırpılmamış emsal listesinden gelir ve kırpma belirtilir', async () => {
    const rawList = Array.from({ length: 35 }, (_, i) => raw(200 + i, i < 5 ? { outlier: true } : {}));
    mockDetail(
      detail({
        comparables: Array.from({ length: 30 }, (_, i) => comp(200 + i)),
        explanation: explanation({ comparables: rawList, pool: { used: 99, outlierIds: [], damagedExcluded: 0 } }),
      }),
    );
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { name: 'Fiyat nasıl hesaplandı?' });
    expect(screen.getByText(/ilk 30 gösteriliyor/)).toBeInTheDocument();
    expect(within(screen.getByText('Kullanılan emsal').nextElementSibling as HTMLElement).getByText('30')).toBeInTheDocument();
    expect(within(screen.getByText('Uç değer sayısı').nextElementSibling as HTMLElement).getByText('5')).toBeInTheDocument();
  });

  it('güven adım kodları Türkçe cümlelere çevrilir', async () => {
    mockDetail(detail());
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { name: 'Fiyat nasıl hesaplandı?' });
    expect(screen.getByText('Kapsam seviyesi güven tavanını belirledi: Yüksek')).toBeInTheDocument();
    expect(screen.getByText('Emsal sayısı az: güven en çok Orta')).toBeInTheDocument();
    expect(screen.getByText('Emsal fiyatları birbirinden çok farklı: güven bir kademe düştü')).toBeInTheDocument();
    expect(screen.queryByText('dispersion:-1')).not.toBeInTheDocument();
    expect(screen.getByText('Emsal fiyatları dağınık')).toBeInTheDocument();
  });

  it('zayıf tahminde indirim sönük ve etiketli gösterilir', async () => {
    mockDetail(
      detail({
        analysis: weakAnalysis('AFTER_OUTLIERS', true),
        explanation: explanation({
          insufficient: true,
          insufficientReason: 'AFTER_OUTLIERS',
          level: 3,
          confidenceSteps: ['insufficient:AFTER_OUTLIERS'],
          flags: [],
        }),
      }),
    );
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/%20 altında \(zayıf tahmin\)/)).toBeInTheDocument();
    expect(screen.getByText(/Yeterli veri yok: uç değerler ayıklandıktan sonra/)).toBeInTheDocument();
  });

  it('http(s) olmayan bağlantı için link çizilmez', async () => {
    mockDetail(detail({ url: 'javascript:alert(1)', comparables: [comp(101, { url: 'javascript:alert(2)' })] }));
    renderWithClient(<ListingPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: /İlana git/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
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
