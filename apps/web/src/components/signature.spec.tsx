import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ListingCard } from '@oto/shared';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { PriceBand } from './price-band';
import { ScoreRing } from './score-ring';
import { ConfidenceMeter } from './confidence-meter';
import { ListingCardView } from './listing-card';
import { ListingTable } from './listing-table';
import { FavoriteButton } from './favorite-button';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

const band = { q1: '1000000', median: '1200000', q3: '1400000' };

const card: ListingCard = {
  id: 7,
  title: 'Temiz 320i',
  make: 'BMW',
  model: '3 Serisi',
  trim: '320i',
  year: 2019,
  km: 85000,
  fuel: 'GASOLINE',
  transmission: 'AUTOMATIC',
  city: 'İstanbul',
  price: '960000',
  imageUrl: null,
  url: 'https://ornek.com/ilan/7',
  status: 'ACTIVE',
  firstSeenAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  isFavorite: false,
  analysis: {
    opportunityScore: 77,
    confidence: 'HIGH',
    estimatedPrice: '1200000',
    priceDiff: '240000',
    discountPct: 0.2,
    comparableCount: 14,
    band,
    flags: [],
    insufficientReason: 'NONE',
  },
};

describe('PriceBand', () => {
  it('labels price and median accessibly', () => {
    render(<PriceBand band={band} price="960000" confidence="HIGH" insufficientReason="NONE" />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toContain('ilan 960.000 ₺');
    expect(img.getAttribute('aria-label')).toContain('medyan 1.200.000 ₺');
  });
  it('shows the weak-estimate text when stats are missing', () => {
    render(
      <PriceBand
        band={{ q1: null, median: null, q3: null }}
        price="960000"
        confidence="INSUFFICIENT"
        insufficientReason="NO_LEVEL"
      />,
    );
    expect(screen.getByText('Zayıf tahmin — yeterli benzer ilan yok')).toBeInTheDocument();
  });
  it('shows the weak-estimate text for the other reasons', () => {
    const { rerender } = render(
      <PriceBand band={{ q1: null, median: null, q3: null }} price="1" confidence="INSUFFICIENT" insufficientReason="AFTER_OUTLIERS" />,
    );
    expect(screen.getByText(/uç değerler ayıklandıktan sonra emsal yetersiz/)).toBeInTheDocument();
    rerender(
      <PriceBand band={{ q1: null, median: null, q3: null }} price="1" confidence="INSUFFICIENT" insufficientReason="INVALID_TARGET" />,
    );
    expect(screen.getByText(/ilan fiyatı geçersiz/)).toBeInTheDocument();
  });
  it('does not crash when the price is far outside the band', () => {
    render(<PriceBand band={band} price="50000" confidence="LOW" insufficientReason="NONE" />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});

describe('PriceBand edges', () => {
  it('states where the price sits relative to the band', () => {
    const { rerender } = render(<PriceBand band={band} price="960000" confidence="HIGH" insufficientReason="NONE" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('bandın altında');
    rerender(<PriceBand band={band} price="1100000" confidence="HIGH" insufficientReason="NONE" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('bandın içinde');
    rerender(<PriceBand band={band} price="1600000" confidence="HIGH" insufficientReason="NONE" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('bandın üstünde');
  });
  it('handles Q1 equal to Q3', () => {
    render(
      <PriceBand
        band={{ q1: '1000000', median: '1000000', q3: '1000000' }}
        price="900000"
        confidence="MEDIUM"
        insufficientReason="NONE"
      />,
    );
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
  it('reports an invalid price', () => {
    render(<PriceBand band={band} price="abc" confidence="HIGH" insufficientReason="NONE" />);
    expect(screen.getByText('Zayıf tahmin — geçersiz fiyat')).toBeInTheDocument();
  });
});

describe('ScoreRing and ConfidenceMeter', () => {
  it('exposes the score', () => {
    render(<ScoreRing score={77} />);
    expect(screen.getByLabelText('Fırsat skoru 77/100')).toBeInTheDocument();
  });
  it('renders a dash for a NaN score', () => {
    render(<ScoreRing score={Number.NaN} />);
    expect(screen.getByLabelText('Fırsat skoru yok')).toHaveTextContent('—');
  });
  it('fills 3 of 4 segments for MEDIUM', () => {
    const { container } = render(<ConfidenceMeter confidence="MEDIUM" comparableCount={6} />);
    expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-filled]')).toHaveLength(4);
    expect(screen.getByText('Orta güven · 6 emsal')).toBeInTheDocument();
  });
});

describe('ListingCardView', () => {
  it('renders the spec layout', () => {
    renderWithClient(<ListingCardView card={card} />);
    expect(screen.getByText('BMW 3 Serisi 320i · 2019')).toBeInTheDocument();
    expect(screen.getByText('960.000 ₺')).toBeInTheDocument();
    expect(screen.getByText('%20 altında')).toBeInTheDocument();
    expect(screen.getByText(/85\.000 km/)).toBeInTheDocument();
    const ext = screen.getByRole('link', { name: /lana git/i });
    expect(ext).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(ext).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'BMW 3 Serisi 320i · 2019' })).toHaveAttribute('href', '/app/ilan/7');
  });
  it('shows REMOVED badge and weak estimate for analysis-less cards', () => {
    renderWithClient(<ListingCardView card={{ ...card, status: 'REMOVED', analysis: null }} />);
    expect(screen.getByText('Yayından kalktı')).toBeInTheDocument();
    expect(screen.getByText(/Zayıf tahmin/)).toBeInTheDocument();
  });
});

describe('discount color', () => {
  it('is green below market and neutral above market', () => {
    const { client, rerender } = renderWithClient(<ListingCardView card={card} />);
    const show = (c: ListingCard) =>
      rerender(
        <QueryClientProvider client={client}>
          <ListingCardView card={c} />
        </QueryClientProvider>,
      );
    expect(screen.getByText('%20 altında').className).toContain('text-positive-text');
    show({ ...card, analysis: { ...card.analysis!, discountPct: -0.05 } });
    expect(screen.getByText('%5 üstünde').className).not.toContain('text-positive-text');
    expect(screen.getByText('%5 üstünde').className).toContain('text-muted');
    show({ ...card, analysis: { ...card.analysis!, discountPct: null } });
    expect(screen.queryByText(/altında|üstünde/)).toBeNull();
  });
});

describe('ListingTable', () => {
  const original = window.matchMedia;
  const setWide = (wide: boolean) => {
    window.matchMedia = ((q: string) => ({
      matches: wide,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = original;
  });

  it('renders an accessible table on wide screens', () => {
    setWide(true);
    renderWithClient(<ListingTable rows={[card]} />);
    expect(screen.getByRole('region', { name: 'İlan tablosu' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('İlan listesi').tagName).toBe('CAPTION');
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('link', { name: 'BMW 3 Serisi 320i · 2019' })).toHaveAttribute('href', '/app/ilan/7');
    const ext = screen.getByRole('link', { name: /lana git: BMW 3 Serisi 320i/ });
    expect(ext).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getAllByText('960.000 ₺')).toHaveLength(1);
  });
  it('renders only the card list on narrow screens', () => {
    setWide(false);
    renderWithClient(<ListingTable rows={[card]} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getAllByText('960.000 ₺')).toHaveLength(1);
  });
});

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { gate, release };
}

describe('FavoriteButton', () => {
  it('toggles optimistically before the response arrives and ignores double clicks', async () => {
    let calls = 0;
    const { gate, release } = gated();
    server.use(
      http.put('*/api/v1/me/favorites/7', async () => {
        calls++;
        await gate;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<FavoriteButton listingId={7} isFavorite={false} />);
    const btn = screen.getByRole('button', { name: 'Favori' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    release();
    await waitFor(() => expect(btn).not.toHaveAttribute('aria-busy'));
    expect(calls).toBe(1);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
  it('rolls back state and cache and toasts on failure', async () => {
    server.use(
      http.put('*/api/v1/me/favorites/7', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 }),
      ),
    );
    const { client } = renderWithClient(<FavoriteButton listingId={7} isFavorite={false} />);
    client.setQueryData(['opportunities', {}], { items: [card] });
    await userEvent.click(screen.getByRole('button', { name: 'Favori' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Favori' })).toHaveAttribute('aria-pressed', 'false'));
    expect(toastError).toHaveBeenCalled();
    expect((client.getQueryData(['opportunities', {}]) as { items: ListingCard[] }).items[0]!.isFavorite).toBe(false);
  });
  it('patches caches optimistically and invalidates related queries on success', async () => {
    const { gate, release } = gated();
    server.use(
      http.put('*/api/v1/me/favorites/7', async () => {
        await gate;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { client } = renderWithClient(<FavoriteButton listingId={7} isFavorite={false} />);
    client.setQueryData(['opportunities', {}], { items: [card, { ...card, id: 8 }] });
    client.setQueryData(['listing', 7], { ...card });
    const spy = vi.spyOn(client, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: 'Favori' }));
    const opp = client.getQueryData(['opportunities', {}]) as { items: ListingCard[] };
    expect(opp.items.map((x) => x.isFavorite)).toEqual([true, false]);
    expect((client.getQueryData(['listing', 7]) as ListingCard).isFavorite).toBe(true);
    release();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const roots = spy.mock.calls.map((c) => (c[0]?.queryKey as string[])[0]);
    expect(roots).toEqual(expect.arrayContaining(['favorites', 'opportunities', 'listing', 'dashboard']));
  });
  it('does not snap back to the stale prop while a request is in flight', async () => {
    const { gate, release } = gated();
    server.use(
      http.put('*/api/v1/me/favorites/7', async () => {
        await gate;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { rerender, client } = renderWithClient(<FavoriteButton listingId={7} isFavorite={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Favori' }));
    rerender(
      <QueryClientProvider client={client}>
        <FavoriteButton listingId={7} isFavorite={false} title="x" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'x favori' })).toHaveAttribute('aria-pressed', 'true');
    release();
  });
  it('uses DELETE when removing', async () => {
    let deleted = false;
    server.use(
      http.delete('*/api/v1/me/favorites/7', () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<FavoriteButton listingId={7} isFavorite />);
    await userEvent.click(screen.getByRole('button', { name: 'Favori' }));
    await waitFor(() => expect(deleted).toBe(true));
  });
  it('includes the listing title in the accessible name', () => {
    renderWithClient(<FavoriteButton listingId={7} isFavorite={false} title="BMW 320i" />);
    expect(screen.getByRole('button', { name: 'BMW 320i favori' })).toBeInTheDocument();
  });
});
