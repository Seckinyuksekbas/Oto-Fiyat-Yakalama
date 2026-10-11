import { describe, expect, it, vi } from 'vitest';
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
    expect(img.getAttribute('aria-label')).toContain('ilan 960.000 ₺');
    expect(img.getAttribute('aria-label')).toContain('medyan 1.200.000 ₺');
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

describe('ScoreRing and ConfidenceMeter', () => {
  it('exposes the score', () => {
    render(<ScoreRing score={77} />);
    expect(screen.getByLabelText('Fırsat skoru 77/100')).toBeInTheDocument();
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
    render(<ListingCardView card={card} />);
    expect(screen.getByText('BMW 3 Serisi 320i · 2019')).toBeInTheDocument();
    expect(screen.getByText('960.000 ₺')).toBeInTheDocument();
    expect(screen.getByText('%20 altında')).toBeInTheDocument();
    expect(screen.getByText(/85\.000 km/)).toBeInTheDocument();
    const ext = screen.getByRole('link', { name: /lana git/i });
    expect(ext).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(ext).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: /BMW 3 Serisi 320i/ })).toHaveAttribute('href', '/app/ilan/7');
  });
  it('shows REMOVED badge and weak estimate for analysis-less cards', () => {
    render(<ListingCardView card={{ ...card, status: 'REMOVED', analysis: null }} />);
    expect(screen.getByText('Yayından kalktı')).toBeInTheDocument();
    expect(screen.getByText(/Zayıf tahmin/)).toBeInTheDocument();
  });
});

describe('ListingTable', () => {
  it('renders rows with detail links', () => {
    render(<ListingTable rows={[card]} />);
    expect(screen.getAllByText('960.000 ₺').length).toBeGreaterThan(0);
  });
});

describe('FavoriteButton', () => {
  it('toggles optimistically', async () => {
    server.use(http.put('*/api/v1/me/favorites/7', () => new HttpResponse(null, { status: 204 })));
    renderWithClient(<FavoriteButton listingId={7} isFavorite={false} />);
    const btn = screen.getByRole('button', { name: 'Favorilere ekle' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: 'Favorilerden çıkar' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('rolls back and toasts on failure', async () => {
    server.use(
      http.put('*/api/v1/me/favorites/7', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 }),
      ),
    );
    renderWithClient(<FavoriteButton listingId={7} isFavorite={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Favorilere ekle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Favorilere ekle' })).toHaveAttribute('aria-pressed', 'false'));
    expect(toastError).toHaveBeenCalled();
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
    await userEvent.click(screen.getByRole('button', { name: 'Favorilerden çıkar' }));
    await waitFor(() => expect(deleted).toBe(true));
  });
});
