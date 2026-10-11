import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListingCard } from '@oto/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/app/firsatlar',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import OpportunitiesPage from './page';

const card = (id: number, over: Partial<ListingCard> = {}): ListingCard => ({
  id,
  title: `Ilan ${id}`,
  make: 'BMW',
  model: '3 Serisi',
  trim: null,
  year: 2019,
  km: 80000,
  fuel: 'GASOLINE',
  transmission: 'AUTOMATIC',
  city: 'İstanbul',
  price: '960000',
  imageUrl: null,
  url: 'https://example.com/x',
  status: 'ACTIVE',
  firstSeenAt: new Date().toISOString(),
  isFavorite: false,
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
  ...over,
});

let requests: URL[] = [];
function mockApi(pages: Record<string, { items: ListingCard[]; nextCursor: string | null }>) {
  server.use(
    http.get('*/api/v1/me/opportunities', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json(pages[url.searchParams.get('cursor') ?? 'first']);
    }),
    http.get('*/api/v1/catalog/makes', () =>
      HttpResponse.json({ items: [{ make: 'BMW', count: 5 }, { make: 'Audi', count: 3 }] }),
    ),
    http.get('*/api/v1/catalog/makes/:make/models', ({ params }) =>
      HttpResponse.json({ items: [{ model: `${String(params.make)}-Model`, count: 2 }] }),
    ),
  );
}

beforeEach(() => {
  requests = [];
  search = '';
  replace.mockReset();
  localStorage.clear();
});

describe('Fırsatlar', () => {
  it('URL filtreleri isteğe taşınır', async () => {
    search = 'make=BMW&maxPrice=1000000&sort=discount&confidence=HIGH';
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    const p = requests[0].searchParams;
    expect(p.get('make')).toBe('BMW');
    expect(p.get('maxPrice')).toBe('1000000');
    expect(p.get('sort')).toBe('discount');
    expect(p.get('confidence')).toBe('HIGH');
  });

  it('marka seçilince URL güncellenir ve model listesi o markadan yüklenir', async () => {
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    const user = userEvent.setup();
    const { rerender, client } = renderWithClient(<OpportunitiesPage />);
    const again = () =>
      rerender(
        <QueryClientProvider client={client}>
          <OpportunitiesPage />
        </QueryClientProvider>,
      );
    await screen.findAllByText(/3 Serisi/);

    await user.click(screen.getByRole('combobox', { name: 'Marka' }));
    await user.click(await screen.findByRole('option', { name: /Audi/ }));
    expect(replace).toHaveBeenCalledWith('/app/firsatlar?make=Audi', { scroll: false });

    search = 'make=Audi';
    again();
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(await screen.findByRole('option', { name: /Audi-Model/ })).toBeInTheDocument();
  });

  it('sıralama değişince URL güncellenir', async () => {
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    const user = userEvent.setup();
    renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('radio', { name: 'İndirim' }));
    expect(replace).toHaveBeenCalledWith('/app/firsatlar?sort=discount', { scroll: false });
  });

  it('cursor ile ikinci sayfa eklenir, aynı id iki kez görünmez', async () => {
    mockApi({
      first: { items: [card(1), card(2)], nextCursor: 'abc' },
      abc: { items: [card(2), card(3, { model: 'X5' })], nextCursor: null },
    });
    const user = userEvent.setup();
    renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    await screen.findAllByText(/X5/);
    expect(requests[1].searchParams.get('cursor')).toBe('abc');
    const links = screen.getAllByRole('link').filter((a) => /^\/app\/ilan\/\d+$/.test(a.getAttribute('href') ?? ''));
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(new Set(hrefs).size).toBe(3);
    expect(screen.queryByRole('button', { name: 'Daha fazla yükle' })).not.toBeInTheDocument();
  });

  it('boş sonuçta boş durum gösterir', async () => {
    mockApi({ first: { items: [], nextCursor: null } });
    renderWithClient(<OpportunitiesPage />);
    expect(await screen.findByText('Şu an listelenecek fırsat yok')).toBeInTheDocument();
  });

  it('tablo/kart seçimi kalıcıdır', async () => {
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    const user = userEvent.setup();
    const first = renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Tablo görünümü' }));
    await waitFor(() => expect(localStorage.getItem('opportunities-view')).toBe('table'));
    first.unmount();

    renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tablo görünümü' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('geçersiz URL parametreleri atılır ve temiz adrese yönlendirilir', async () => {
    search = 'sort=bogus&minScore=5&maxPrice=abc&confidence=LOW&make=BMW&model=X5&city=' + 'a'.repeat(61);
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    const keys = [...requests[0].searchParams.keys()].sort();
    expect(keys).toEqual(['limit', 'make', 'model']);
    expect(replace).toHaveBeenCalledWith('/app/firsatlar?make=BMW&model=X5', { scroll: false });
  });

  it('markasız model parametresi temizlenir', async () => {
    search = 'model=X5&minScore=75';
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    expect(requests[0].searchParams.has('model')).toBe(false);
    expect(requests[0].searchParams.get('minScore')).toBe('75');
    expect(replace).toHaveBeenCalledWith('/app/firsatlar?minScore=75', { scroll: false });
  });

  it('şehir ve fiyat girdileri bekletilip tek seferde URL e yazılır; sondaki boşluk korunur', async () => {
    mockApi({ first: { items: [card(1)], nextCursor: null } });
    const user = userEvent.setup();
    const { rerender, client } = renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.type(screen.getByLabelText('Şehir'), 'Ankara ');
    expect(replace).not.toHaveBeenCalled();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app/firsatlar?city=Ankara', { scroll: false }));
    expect(replace).toHaveBeenCalledTimes(1);
    search = 'city=Ankara';
    rerender(
      <QueryClientProvider client={client}>
        <OpportunitiesPage />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('Şehir')).toHaveValue('Ankara ');

    replace.mockClear();
    await user.type(screen.getByLabelText('En yüksek fiyat (₺)'), '1a5');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app/firsatlar?city=Ankara&maxPrice=15', { scroll: false }));
  });

  it('IntersectionObserver görünür olunca sonraki sayfayı yükler; hata sonrası otomatik yeniden denemez', async () => {
    let trigger: () => void = () => {};
    class IO {
      private live = true;
      constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
        trigger = () => {
          if (this.live) cb([{ isIntersecting: true }]);
        };
      }
      observe() {}
      disconnect() {
        this.live = false;
      }
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', IO);
    let fail = true;
    server.use(
      http.get('*/api/v1/me/opportunities', ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        if (!url.searchParams.get('cursor')) return HttpResponse.json({ items: [card(1)], nextCursor: 'p2' });
        return fail
          ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 })
          : HttpResponse.json({ items: [card(2, { model: 'X5' })], nextCursor: null });
      }),
      http.get('*/api/v1/catalog/makes', () => HttpResponse.json({ items: [] })),
    );
    try {
      const user = userEvent.setup();
      renderWithClient(<OpportunitiesPage />);
      await screen.findAllByText(/3 Serisi/);
      trigger();
      expect(await screen.findByText('Sonraki sayfa yüklenemedi. Tekrar deneyin.')).toBeInTheDocument();
      expect(screen.getAllByText(/3 Serisi/).length).toBeGreaterThan(0); // liste yerinde kalır
      const before = requests.length;
      trigger();
      await new Promise((r) => setTimeout(r, 50));
      expect(requests.length).toBe(before);
      fail = false;
      await user.click(screen.getByRole('button', { name: 'Tekrar dene' }));
      await screen.findAllByText(/X5/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('filtre değişince ikinci sayfa satırları düşer', async () => {
    server.use(
      http.get('*/api/v1/me/opportunities', ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        if (url.searchParams.get('sort') === 'recent') return HttpResponse.json({ items: [card(9, { model: 'Z4' })], nextCursor: null });
        if (url.searchParams.get('cursor')) return HttpResponse.json({ items: [card(2, { model: 'X5' })], nextCursor: null });
        return HttpResponse.json({ items: [card(1)], nextCursor: 'p2' });
      }),
      http.get('*/api/v1/catalog/makes', () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    const { rerender, client } = renderWithClient(<OpportunitiesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    await screen.findAllByText(/X5/);
    search = 'sort=recent';
    rerender(
      <QueryClientProvider client={client}>
        <OpportunitiesPage />
      </QueryClientProvider>,
    );
    await screen.findAllByText(/Z4/);
    expect(screen.queryByText(/X5/)).not.toBeInTheDocument();
    expect(requests[requests.length - 1].searchParams.has('cursor')).toBe(false);
  });
});
