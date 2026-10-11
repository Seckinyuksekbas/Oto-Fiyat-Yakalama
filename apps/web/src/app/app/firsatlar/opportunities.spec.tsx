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
});
