import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const push = vi.fn();
const replace = vi.fn();
let search = new URLSearchParams();
let pathname = '/app/firsatlar';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => search,
  usePathname: () => pathname,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: (...a: unknown[]) => toastError(...a), success: vi.fn() }),
}));

import { LoginForm } from '@/app/(auth)/giris/login-form';
import { UserMenu } from '@/components/user-menu';
import { AppShell } from '@/components/app-shell';
import { ExternalListingLink } from '@/components/listing-card';
import { FavoriteButton } from '@/components/favorite-button';
import { RetryFlagStripper, withRetryFlag } from '@/lib/session';
import { parseOpportunityParams } from '@/lib/panel-queries';
import { useMarkRead, useUnreadCount } from '@/lib/notification-queries';
import { NOTIFICATION_KEYS } from '@/lib/sse';
import { profileKeys, useDeleteProfile } from '@/lib/profile-queries';
import { CHANNELS_KEY } from '@/lib/channels';
import { settingsKeys } from '@/lib/settings-queries';

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  toastError.mockReset();
  search = new URLSearchParams();
  pathname = '/app/firsatlar';
});
afterEach(() => vi.unstubAllGlobals());

const me = { user: { id: 'u1', email: 'a@b.co', name: 'Ali Veli' } };
const unauth = () => HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: '' } }, { status: 401 });
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (client: QueryClient) =>
  function W({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

describe('logout then login page', () => {
  it('does not bounce back to /app on a stale cached /me', async () => {
    server.use(
      http.get('/api/v1/me', unauth),
      http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })),
    );
    const client = newClient();
    client.setQueryData(['me'], me);
    client.setQueryData(['dashboard'], { x: 1 });
    const W = wrap(client);
    const first = render(
      <W>
        <UserMenu />
      </W>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Hesap menüsü/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Çıkış/ }));
    expect(replace).toHaveBeenCalledWith('/giris');
    expect(client.getQueryData(['me'])).toBeUndefined();
    expect(client.getQueryData(['dashboard'])).toBeUndefined();
    first.unmount();

    replace.mockClear();
    render(
      <W>
        <LoginForm />
      </W>,
    );
    await screen.findByLabelText('E-posta');
    await new Promise((r) => setTimeout(r, 60));
    expect(replace).not.toHaveBeenCalled();
  });

  it('a stale ["me"] success in the cache never redirects the login form', async () => {
    server.use(http.get('/api/v1/me', unauth));
    const client = newClient();
    client.setQueryData(['me'], me);
    const W = wrap(client);
    render(
      <W>
        <LoginForm />
      </W>,
    );
    await screen.findByLabelText('E-posta');
    await new Promise((r) => setTimeout(r, 60));
    expect(replace).not.toHaveBeenCalled();
  });

  it('still redirects a genuinely signed-in visitor', async () => {
    server.use(http.get('/api/v1/me', () => HttpResponse.json(me)));
    renderWithClient(<LoginForm />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app'));
  });
});

describe('sticky _r flag', () => {
  it('after a successful refresh uses a hard navigation (no client-side router state)', async () => {
    const hard = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace: hard });
    search = new URLSearchParams({ next: '/app/favoriler', try_refresh: '1' });
    server.use(http.post('/api/v1/auth/refresh', () => new HttpResponse(null, { status: 204 })));
    renderWithClient(<LoginForm />);
    await waitFor(() => expect(hard).toHaveBeenCalledWith('/app/favoriler?_r=1'));
    expect(replace).not.toHaveBeenCalled();
  });

  it('RetryFlagStripper removes _r on the panel but keeps other params', async () => {
    search = new URLSearchParams('make=bmw&_r=1');
    render(<RetryFlagStripper />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app/firsatlar?make=bmw', { scroll: false }));
  });

  it('RetryFlagStripper does nothing without the flag', () => {
    search = new URLSearchParams('make=bmw');
    render(<RetryFlagStripper />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('strips to the bare path when _r was the only param', async () => {
    search = new URLSearchParams(withRetryFlag('/app/firsatlar').split('?')[1]);
    render(<RetryFlagStripper />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app/firsatlar', { scroll: false }));
  });

  it('parseOpportunityParams drops _r and unknown keys', () => {
    const { clean, filters } = parseOpportunityParams(new URLSearchParams('make=BMW&_r=1&foo=bar&sort=recent'));
    expect(clean).toBe('make=BMW&sort=recent');
    expect(filters).toEqual({ make: 'BMW', sort: 'recent' });
  });
});

describe('ExternalListingLink', () => {
  it('renders nothing for non-http urls', () => {
    const { container } = render(<ExternalListingLink url="javascript:alert(1)" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders a link for https', () => {
    render(<ExternalListingLink url="https://x.test/a" title="BMW" />);
    expect(screen.getByRole('link', { name: /İlana git: BMW/ })).toHaveAttribute('href', 'https://x.test/a');
  });
});

describe('unread count', () => {
  const page = (unreadCount: number) => HttpResponse.json({ items: [], nextCursor: null, unreadCount });

  it('a refetch returns the server value instead of the older cached number', async () => {
    let served = 3;
    server.use(http.get('/api/v1/me/notifications', () => page(served)));
    const client = newClient();
    const { result } = renderHook(() => useUnreadCount(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toBe(3));
    served = 5;
    await act(async () => {
      await client.invalidateQueries({ queryKey: NOTIFICATION_KEYS.unread });
    });
    await waitFor(() => expect(result.current.data).toBe(5));
  });

  it('mark-read ends with the server-derived count, not prev - updated', async () => {
    let served = 4;
    server.use(
      http.get('/api/v1/me/notifications', () => page(served)),
      http.post('/api/v1/me/notifications/read', () => {
        served = 7;
        return HttpResponse.json({ updated: 1 });
      }),
    );
    const client = newClient();
    const { result } = renderHook(() => ({ count: useUnreadCount(), mark: useMarkRead() }), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.count.data).toBe(4));
    await act(async () => {
      await result.current.mark.mutateAsync({ ids: [1] });
    });
    await waitFor(() => expect(result.current.count.data).toBe(7));
  });
});

describe('shared channels module', () => {
  it('profiles and settings use one key', () => {
    expect(profileKeys.channels).toBe(CHANNELS_KEY);
    expect(settingsKeys.channels).toBe(CHANNELS_KEY);
  });
});

describe('profile mutations', () => {
  it('invalidate subscription and matches too', async () => {
    server.use(http.delete('/api/v1/me/search-profiles/:id', () => new HttpResponse(null, { status: 204 })));
    const client = newClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteProfile(), { wrapper: wrap(client) });
    await act(async () => {
      await result.current.mutateAsync('p1');
    });
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['subscription']));
    expect(keys).toContain(JSON.stringify(['matches']));
  });
});

describe('FavoriteButton cache refresh', () => {
  it('does not refetch opportunities lists but still refreshes favorites', async () => {
    server.use(http.put('/api/v1/me/favorites/:id', () => new HttpResponse(null, { status: 204 })));
    const counts = { opp: 0, fav: 0 };
    function Probe() {
      useQuery({
        queryKey: ['opportunities', {}],
        queryFn: async () => {
          counts.opp++;
          return { items: [] };
        },
        staleTime: Infinity,
      });
      useQuery({
        queryKey: ['favorites'],
        queryFn: async () => {
          counts.fav++;
          return { items: [] };
        },
        staleTime: Infinity,
      });
      return <FavoriteButton listingId={5} isFavorite={false} title="BMW" />;
    }
    renderWithClient(<Probe />);
    await waitFor(() => expect(counts).toEqual({ opp: 1, fav: 1 }));
    await userEvent.click(screen.getByRole('button', { name: /favori/ }));
    await waitFor(() => expect(counts.fav).toBe(2));
    expect(counts.opp).toBe(1);
  });
});

describe('app shell headings', () => {
  it('has no h1 of its own (pages own the single h1)', () => {
    renderWithClient(
      <AppShell>
        <h1>Sayfa</h1>
      </AppShell>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
