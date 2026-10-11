import { cloneElement } from 'react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, ListingCard } from '@oto/shared';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const push = vi.fn();
const replace = vi.fn();
let pathname = '/app';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// jsdom'da ölçü yok: grafik kabını sabit boyutla çiz.
vi.mock('recharts', async (orig) => {
  const mod = await orig<typeof import('recharts')>();
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 400, height: 160 }}>{cloneElement(children, { width: 400, height: 160 } as object)}</div>
    ),
  };
});

import { AppShell } from '@/components/app-shell';
import { DashboardView } from './dashboard';

const card = (id: number): ListingCard => ({
  id,
  title: `Ilan ${id}`,
  make: 'BMW',
  model: '3 Serisi',
  trim: '320i',
  year: 2019,
  km: 80000,
  fuel: 'PETROL',
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
});

const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  recentMatches: [1, 2].map((id) => ({
    id,
    reason: 'NEW' as const,
    createdAt: new Date().toISOString(),
    profile: { id: 'p1', name: 'Günlük araç' },
    listing: card(id),
  })),
  profiles: { active: 2, total: 3, max: 5 },
  notifications: { today: 4, limit: 20 },
  series: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((day, i) => ({
    day,
    matches: i + 1,
  })),
  ...over,
});

const meBody = (verified = true) => ({
  user: {
    id: 'u1',
    email: 'ayse@example.com',
    name: 'Ayşe Yılmaz',
    role: 'USER',
    status: 'ACTIVE',
    emailVerifiedAt: verified ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
  },
  subscription: { planCode: 'PRO', planName: 'Pro', status: 'ACTIVE', endsAt: null, limits: {} },
  usage: { searchProfiles: 2, notificationsToday: 4 },
});

function useApi(opts: { verified?: boolean; dashboard?: Dashboard } = {}) {
  server.use(
    http.get('*/api/v1/me', () => HttpResponse.json(meBody(opts.verified ?? true))),
    http.get('*/api/v1/me/dashboard', () => HttpResponse.json(opts.dashboard ?? dash())),
  );
}

const page = () =>
  renderWithClient(
    <AppShell>
      <DashboardView />
    </AppShell>,
  );

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  pathname = '/app';
});

const realMatchMedia = window.matchMedia;
const realWidth = window.innerWidth;
afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.innerWidth = realWidth;
  vi.useRealTimers();
});

describe('Dashboard', () => {
  it('shows the four metrics and recent matches', async () => {
    useApi();
    page();
    const profiles = await screen.findByRole('group', { name: 'Aktif profil' });
    expect(within(profiles).getByText('2/5')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Bugünkü bildirim' })).getByText('4/20')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '7 günlük eşleşme' })).getByText('28')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Plan' })).getByText('Pro')).toBeInTheDocument());
    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /7 günlük eşleşme grafiği/ })).toBeInTheDocument();
  });

  it('shows a create-profile CTA when there are no profiles', async () => {
    useApi({ dashboard: dash({ recentMatches: [], profiles: { active: 0, total: 0, max: 1 } }) });
    page();
    const cta = await screen.findByRole('link', { name: 'İlk arama profilinizi oluşturun' });
    expect(cta).toHaveAttribute('href', '/app/profiller/yeni');
  });

  it('explains empty matches when a profile exists', async () => {
    useApi({ dashboard: dash({ recentMatches: [] }) });
    page();
    expect(await screen.findByText(/Yeni profiller, oluşturulduktan sonra analiz edilen ilanlarla eşleşir/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fırsatlara bak' })).toHaveAttribute('href', '/app/firsatlar');
  });
});

describe('AppShell', () => {
  it('marks the active nav item', async () => {
    useApi();
    pathname = '/app/favoriler';
    page();
    const nav = screen.getByRole('navigation', { name: 'Ana menü' });
    expect(within(nav).getByRole('link', { name: 'Favoriler' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('shows the verify banner and resends the link', async () => {
    useApi({ verified: false });
    let body: unknown;
    server.use(
      http.post('*/api/v1/auth/resend-verification', async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    page();
    expect(await screen.findByText(/E-postanızı doğrulayın/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Bağlantıyı yeniden gönder' }));
    await waitFor(() => expect(body).toEqual({ email: 'ayse@example.com' }));
    expect(await screen.findByText(/Bağlantı gönderildi/)).toBeInTheDocument();
  });

  it('hides the banner for verified users', async () => {
    useApi();
    page();
    await screen.findByRole('group', { name: 'Aktif profil' });
    expect(screen.queryByText(/E-postanızı doğrulayın/)).not.toBeInTheDocument();
  });

  it('opens the drawer with the hamburger and closes it with Esc', async () => {
    useApi();
    page();
    await userEvent.click(screen.getByRole('button', { name: 'Menüyü aç' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menü' });
    expect(within(drawer).getByRole('link', { name: 'Eşleşmeler' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('logs out and redirects to /giris', async () => {
    useApi();
    let called = false;
    server.use(
      http.post('*/api/v1/auth/logout', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    page();
    await userEvent.click(await screen.findByRole('button', { name: /Hesap menüsü/ }));
    expect(await screen.findByText('ayse@example.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Çıkış' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/giris'));
    expect(called).toBe(true);
  });

  it('puts a skip link first and targets the focusable main region', async () => {
    useApi();
    page();
    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'İçeriğe geç' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#icerik');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'icerik');
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('closes the drawer when the viewport grows past md', async () => {
    useApi();
    let listener: ((e: { matches: boolean }) => void) | undefined;
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        if (q.includes('min-width')) listener = fn;
      },
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    page();
    await userEvent.click(screen.getByRole('button', { name: 'Menüyü aç' }));
    await screen.findByRole('dialog', { name: 'Menü' });
    act(() => listener?.({ matches: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not refetch /me after logout', async () => {
    let meCalls = 0;
    let loggedOut = false;
    server.use(
      http.get('*/api/v1/me', () => {
        meCalls++;
        return HttpResponse.json(meBody());
      }),
      http.get('*/api/v1/me/dashboard', () => HttpResponse.json(dash())),
      http.post('*/api/v1/auth/logout', () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    page();
    await userEvent.click(await screen.findByRole('button', { name: /Hesap menüsü/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Çıkış' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/giris'));
    await waitFor(() => expect(loggedOut).toBe(true));
    await new Promise((r) => setTimeout(r, 100));
    const before = meCalls;
    await new Promise((r) => setTimeout(r, 200));
    expect(meCalls).toBe(before);
  });

  it('explains a rate-limited resend (429)', async () => {
    useApi({ verified: false });
    server.use(
      http.post('*/api/v1/auth/resend-verification', () =>
        HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'x' } }, { status: 429 }),
      ),
    );
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantıyı yeniden gönder' }));
    expect(await screen.findByText(/Çok sık denediniz/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bağlantıyı yeniden gönder' })).toBeEnabled();
  });

  it('shows a generic failure on 500 and keeps the button usable', async () => {
    useApi({ verified: false });
    server.use(
      http.post('*/api/v1/auth/resend-verification', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 }),
      ),
    );
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantıyı yeniden gönder' }));
    expect(await screen.findByText(/Bağlantı gönderilemedi/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bağlantıyı yeniden gönder' })).toBeEnabled();
  });

  it('disables resend for 60 seconds with a countdown after success', async () => {
    useApi({ verified: false });
    server.use(
      http.post('*/api/v1/auth/resend-verification', () => new HttpResponse(null, { status: 204 })),
    );
    page();
    const btn = await screen.findByRole('button', { name: 'Bağlantıyı yeniden gönder' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(btn);
    expect(await screen.findByText(/60 sn bekleyin/)).toBeInTheDocument();
    expect(btn).toBeDisabled();
    for (let i = 0; i < 60; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it('shows the profile name and reason badge on recent matches', async () => {
    const d = dash();
    d.recentMatches[1] = { ...d.recentMatches[1]!, reason: 'PRICE_DROP' };
    useApi({ dashboard: d });
    page();
    expect((await screen.findAllByText('Günlük araç')).length).toBe(2);
    expect(screen.getByText('Yeni')).toBeInTheDocument();
    expect(screen.getByText('Fiyat düştü')).toBeInTheDocument();
  });

  it('labels the fallback plan as free', async () => {
    server.use(
      http.get('*/api/v1/me', () =>
        HttpResponse.json({ ...meBody(), subscription: { planCode: 'FREE', planName: 'Free', status: 'FALLBACK', endsAt: null } }),
      ),
      http.get('*/api/v1/me/dashboard', () => HttpResponse.json(dash())),
    );
    page();
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Plan' })).getByText('Ücretsiz plan')).toBeInTheDocument());
  });

  it('leaves a slot for the notification bell', () => {
    useApi();
    renderWithClient(
      <AppShell bellSlot={<button>zil</button>}>
        <p>x</p>
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'zil' })).toBeInTheDocument();
  });
});
