import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { Toaster } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FavoriteItem, ListingCard } from '@oto/shared';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/favoriler',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import FavoritesPage from './page';

const card = (id: number, model = '3 Serisi'): ListingCard => ({
  id,
  title: `Ilan ${id}`,
  make: 'BMW',
  model,
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
  isFavorite: true,
  analysis: null,
});
const fav = (id: number, note: string | null = null, model?: string): FavoriteItem => ({
  listing: card(id, model),
  note,
  createdAt: new Date().toISOString(),
});

interface Calls {
  put: Array<{ id: string; body: { note: string | null } }>;
  del: string[];
  gets: URL[];
}
let calls: Calls;
let items: FavoriteItem[];

function mockApi(pages?: Record<string, { items: FavoriteItem[]; nextCursor: number | null }>) {
  server.use(
    http.get('*/api/v1/me/favorites', ({ request }) => {
      const url = new URL(request.url);
      calls.gets.push(url);
      if (pages) return HttpResponse.json(pages[url.searchParams.get('cursor') ?? 'first']);
      return HttpResponse.json({ items, nextCursor: null });
    }),
  );
}

function renderPage() {
  return renderWithClient(
    <>
      <Toaster />
      <FavoritesPage />
    </>,
  );
}

const errorBody = { error: { code: 'INTERNAL', message: 'x' } };

beforeEach(() => {
  calls = { put: [], del: [], gets: [] };
  items = [fav(1, 'ilk not'), fav(2)];
});

describe('Favoriler', () => {
  it('not düzenleme: PUT gönderir, toast gösterir ve düzenlemeden çıkar', async () => {
    mockApi();
    server.use(
      http.put('*/api/v1/me/favorites/:id', async ({ request, params }) => {
        calls.put.push({ id: String(params.id), body: (await request.json()) as { note: string | null } });
        return HttpResponse.json(fav(1, 'yeni not'));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Notu düzenle' }));
    const box = screen.getByLabelText('Favori notu');
    await user.clear(box);
    await user.type(box, 'yeni not');
    await user.click(screen.getByRole('button', { name: 'Notu kaydet' }));
    await waitFor(() => expect(calls.put).toEqual([{ id: '1', body: { note: 'yeni not' } }]));
    expect(await screen.findByText('Not kaydedildi')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Favori notu')).not.toBeInTheDocument());
  });

  it('boş not null olarak gönderilir', async () => {
    mockApi();
    server.use(
      http.put('*/api/v1/me/favorites/:id', async ({ request, params }) => {
        calls.put.push({ id: String(params.id), body: (await request.json()) as { note: string | null } });
        return HttpResponse.json(fav(1));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Notu düzenle' }));
    await user.clear(screen.getByLabelText('Favori notu'));
    await user.click(screen.getByRole('button', { name: 'Notu kaydet' }));
    await waitFor(() => expect(calls.put[0].body).toEqual({ note: null }));
  });

  it('sayaç ve 280 karakter sınırı', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { name: 'Not ekle' }))[0]);
    const box = screen.getByLabelText('Favori notu');
    expect(box).toHaveAttribute('maxlength', '280');
    await user.type(box, 'abcde');
    expect(screen.getByText('5/280')).toBeInTheDocument();
  });

  it('vazgeç istek göndermez, Escape düzenlemeyi kapatıp odağı geri verir', async () => {
    mockApi();
    server.use(
      http.put('*/api/v1/me/favorites/:id', () => {
        calls.put.push({ id: 'x', body: { note: null } });
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Notu düzenle' }));
    await user.type(screen.getByLabelText('Favori notu'), ' x');
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(screen.queryByLabelText('Favori notu')).not.toBeInTheDocument();
    expect(screen.getByText('ilk not')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notu düzenle' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Notu düzenle' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Favori notu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notu düzenle' })).toHaveFocus();
    expect(calls.put).toHaveLength(0);
  });

  it('kaydetme hatasında taslak korunur', async () => {
    mockApi();
    server.use(http.put('*/api/v1/me/favorites/:id', () => HttpResponse.json(errorBody, { status: 500 })));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Notu düzenle' }));
    const box = screen.getByLabelText('Favori notu');
    await user.clear(box);
    await user.type(box, 'kayıp olmasın');
    await user.click(screen.getByRole('button', { name: 'Notu kaydet' }));
    await screen.findByText(/Bir sorun oluştu/);
    expect(screen.getByLabelText('Favori notu')).toHaveValue('kayıp olmasın');
  });

  it('kaldırınca kart gizlenir, DELETE gider; Geri al özgün notla PUT gönderir', async () => {
    mockApi();
    server.use(
      http.delete('*/api/v1/me/favorites/:id', ({ params }) => {
        calls.del.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      http.put('*/api/v1/me/favorites/:id', async ({ request, params }) => {
        calls.put.push({ id: String(params.id), body: (await request.json()) as { note: string | null } });
        return HttpResponse.json(fav(1, 'ilk not'));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ilk not');
    await user.click(screen.getAllByRole('button', { pressed: true })[0]);
    await waitFor(() => expect(screen.queryByText('ilk not')).not.toBeInTheDocument());
    expect(calls.del).toEqual(['1']);
    expect(calls.put).toHaveLength(0); // geri alma, DELETE bitmeden sunulmaz
    await user.click(await screen.findByRole('button', { name: 'Geri al' }));
    await waitFor(() => expect(calls.put).toEqual([{ id: '1', body: { note: 'ilk not' } }]));
    expect(await screen.findByText('ilk not')).toBeInTheDocument();
  });

  it('DELETE başarısız olursa kart geri gelir', async () => {
    mockApi();
    server.use(http.delete('*/api/v1/me/favorites/:id', () => HttpResponse.json(errorBody, { status: 500 })));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('ilk not');
    await user.click(screen.getAllByRole('button', { pressed: true })[0]);
    await screen.findByText(/Bir sorun oluştu/);
    expect(screen.getByText('ilk not')).toBeInTheDocument();
  });

  it('son kart kaldırılınca boş durum görünür', async () => {
    items = [fav(1)];
    mockApi();
    server.use(
      http.delete('*/api/v1/me/favorites/:id', () => {
        items = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click((await screen.findAllByRole('button', { pressed: true }))[0]);
    expect(await screen.findByText('Henüz favori ilanınız yok')).toBeInTheDocument();
  });

  it('sayfalama cursor gönderir ve aynı ilanı iki kez göstermez', async () => {
    mockApi({
      first: { items: [fav(1), fav(2)], nextCursor: 55 },
      '55': { items: [fav(2), fav(3, null, 'X5')], nextCursor: null },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    await screen.findAllByText(/X5/);
    expect(calls.gets[1].searchParams.get('cursor')).toBe('55');
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(3);
    expect(within(document.body).queryByRole('button', { name: 'Daha fazla yükle' })).not.toBeInTheDocument();
  });

  it('sonraki sayfa hatasında liste korunur ve yeniden denenebilir', async () => {
    let fail = true;
    server.use(
      http.get('*/api/v1/me/favorites', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (!cursor) return HttpResponse.json({ items: [fav(1)], nextCursor: 9 });
        return fail
          ? HttpResponse.json(errorBody, { status: 500 })
          : HttpResponse.json({ items: [fav(2, null, 'X5')], nextCursor: null });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    expect(await screen.findByText('Sonraki sayfa yüklenemedi. Tekrar deneyin.')).toBeInTheDocument();
    expect(screen.getAllByText(/3 Serisi/).length).toBeGreaterThan(0);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    await screen.findAllByText(/X5/);
  });
});
