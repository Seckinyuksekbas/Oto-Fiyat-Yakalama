import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import type { MatchRow } from '@/lib/panel-queries';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/eslesmeler',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import MatchesPage from './page';

const row = (id: number, over: Partial<MatchRow> = {}, model = '3 Serisi'): MatchRow => ({
  id,
  reason: 'NEW',
  matchedPrice: '960000',
  createdAt: new Date().toISOString(),
  profile: { id: 'p1', name: 'Günlük araç' },
  listing: {
    id: id * 10,
    title: `Ilan ${id}`,
    make: 'BMW',
    model,
    year: 2019,
    km: 80000,
    city: 'İstanbul',
    price: '960000',
    imageUrl: null,
    url: 'https://example.com/x',
    status: 'ACTIVE',
  },
  analysis: { opportunityScore: 77, confidence: 'HIGH', discountPct: 0.2, estimatedPrice: '1200000' },
  ...over,
});

let gets: URL[];
type Reply = { items: MatchRow[]; nextCursor: number | null };

function mockApi(reply: (u: URL) => Reply | 'error') {
  server.use(
    http.get('*/api/v1/me/matches', ({ request }) => {
      const u = new URL(request.url);
      gets.push(u);
      const r = reply(u);
      return r === 'error' ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 }) : HttpResponse.json(r);
    }),
    http.get('*/api/v1/me/search-profiles', () => HttpResponse.json([{ id: 'p1', name: 'Günlük araç' }, { id: 'p2', name: 'Hafta sonu' }])),
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string | RegExp) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  gets = [];
});

describe('Eşleşmeler', () => {
  it('her filtre isteğe parametre olarak gider, Tümü parametreyi kaldırır', async () => {
    mockApi(() => ({ items: [row(1)], nextCursor: null }));
    const user = userEvent.setup();
    renderWithClient(<MatchesPage />);
    await screen.findAllByText(/3 Serisi/);
    expect([...gets[0].searchParams.keys()].sort()).toEqual(['limit']);

    await pick(user, 'Profil', 'Hafta sonu');
    await pick(user, 'Neden', 'Fiyat düştü');
    await pick(user, 'Güven', 'Yüksek');
    await pick(user, 'En düşük skor', /80/);
    await vi.waitFor(() => {
      const p = gets[gets.length - 1].searchParams;
      expect(p.get('profileId')).toBe('p2');
      expect(p.get('reason')).toBe('PRICE_DROP');
      expect(p.get('confidence')).toBe('HIGH');
      expect(p.get('minScore')).toBe('80');
    });

    await pick(user, 'Neden', 'Tüm nedenler');
    await vi.waitFor(() => expect(gets[gets.length - 1].searchParams.has('reason')).toBe(false));
    expect(gets[gets.length - 1].searchParams.get('profileId')).toBe('p2');
  });

  it('filtre değişince cursor sıfırlanır ve önceki sayfa satırları düşer', async () => {
    mockApi((u) => {
      if (u.searchParams.get('reason') === 'RELIST') return { items: [row(7, { reason: 'RELIST' }, 'Z4')], nextCursor: null };
      if (u.searchParams.get('cursor')) return { items: [row(2, {}, 'X5')], nextCursor: null };
      return { items: [row(1)], nextCursor: 40 };
    });
    const user = userEvent.setup();
    renderWithClient(<MatchesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    await screen.findAllByText(/X5/);
    expect(gets[1].searchParams.get('cursor')).toBe('40');
    await pick(user, 'Neden', 'Yeniden yayında');
    await screen.findAllByText(/Z4/);
    expect(screen.queryByText(/X5/)).not.toBeInTheDocument();
    expect(gets[gets.length - 1].searchParams.has('cursor')).toBe(false);
  });

  it('aynı eşleşme iki sayfada gelirse tek kez görünür', async () => {
    mockApi((u) =>
      u.searchParams.get('cursor') ? { items: [row(1), row(2, {}, 'X5')], nextCursor: null } : { items: [row(1)], nextCursor: 1 },
    );
    const user = userEvent.setup();
    renderWithClient(<MatchesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    await screen.findAllByText(/X5/);
    expect(screen.getAllByText(/3 Serisi/)).toHaveLength(1);
  });

  it('neden etiketi, REMOVED rozeti ve zayıf tahmin indirimi', async () => {
    mockApi(() => ({
      items: [
        row(1, { reason: 'PRICE_DROP' }),
        row(2, { reason: 'RELIST', listing: { ...row(2).listing, status: 'REMOVED' } }, 'X5'),
        row(3, { analysis: { opportunityScore: 40, confidence: 'INSUFFICIENT', discountPct: 0.2, estimatedPrice: null } }, 'Z4'),
      ],
      nextCursor: null,
    }));
    renderWithClient(<MatchesPage />);
    await screen.findAllByText(/3 Serisi/);
    expect(screen.getAllByText('Fiyat düştü').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Yeniden yayında').length).toBeGreaterThan(0);
    expect(screen.getByText('Yayından kalktı')).toBeInTheDocument();
    expect(screen.getByText(/%20 altında \(zayıf tahmin\)/)).toBeInTheDocument();
  });

  it('boş durum filtreye göre değişir', async () => {
    mockApi(() => ({ items: [], nextCursor: null }));
    const user = userEvent.setup();
    renderWithClient(<MatchesPage />);
    expect(await screen.findByText('Henüz eşleşme yok')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profil oluştur' })).toBeInTheDocument();
    await pick(user, 'Güven', 'Yüksek');
    expect(await screen.findByText('Bu filtrelerle eşleşme yok')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profil oluştur' })).not.toBeInTheDocument();
  });

  it('ilk yükleme hatasında yeniden denenebilir', async () => {
    let fail = true;
    mockApi(() => (fail ? 'error' : { items: [row(1)], nextCursor: null }));
    const user = userEvent.setup();
    renderWithClient(<MatchesPage />);
    const retry = await screen.findByRole('button', { name: 'Yeniden dene' });
    fail = false;
    await user.click(retry);
    await screen.findAllByText(/3 Serisi/);
  });

  it('sonraki sayfa hatasında uyarı ve tekrar dene', async () => {
    let fail = true;
    mockApi((u) => {
      if (!u.searchParams.get('cursor')) return { items: [row(1)], nextCursor: 5 };
      return fail ? 'error' : { items: [row(2, {}, 'X5')], nextCursor: null };
    });
    const user = userEvent.setup();
    renderWithClient(<MatchesPage />);
    await screen.findAllByText(/3 Serisi/);
    await user.click(screen.getByRole('button', { name: 'Daha fazla yükle' }));
    expect(await screen.findByText('Sonraki sayfa yüklenemedi. Tekrar deneyin.')).toBeInTheDocument();
    expect(screen.getAllByText(/3 Serisi/)).toHaveLength(1);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    await screen.findAllByText(/X5/);
  });
});
