import { StrictMode, act } from 'react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/bildirimler',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PanelWithNotifications } from '@/components/notification-bell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { emitLoggedOut } from '@/lib/session';
import { NotificationsView } from './notifications-view';

class FakeES {
  static instances: FakeES[] = [];
  closed = false;
  withCredentials: boolean;
  private l = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(
    readonly url: string,
    init?: { withCredentials?: boolean },
  ) {
    this.withCredentials = init?.withCredentials ?? false;
    FakeES.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    this.l.set(t, [...(this.l.get(t) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(t: string, data: unknown) {
    act(() => {
      for (const fn of this.l.get(t) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
    });
  }
}

const matchPayload = (id: number, over: Record<string, unknown> = {}) => ({
  type: 'MATCH',
  reason: 'NEW',
  profile: { id: 'p1', name: 'Günlük BMW' },
  listing: {
    id, title: 't', make: 'BMW', model: '3 Serisi', trim: '320i', year: 2022, km: 40000, fuel: 'PETROL',
    transmission: 'AUTOMATIC', city: 'İstanbul', price: '960000', imageUrl: null, url: 'https://x.test/1',
    firstSeenAt: '2026-10-11T10:00:00.000Z',
  },
  analysis: { opportunityScore: 82, confidence: 'HIGH', estimatedPrice: '1280000', priceDiff: '320000', discountPct: 0.25, comparableCount: 14 },
  previousPrice: null,
  limitExceeded: false,
  ...over,
});
const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, kind: 'MATCH', channel: 'IN_APP', status: 'SENT', attempts: 1, lastError: null, payload: matchPayload(id),
  sentAt: null, readAt: null, createdAt: '2026-10-11T10:00:00.000Z', ...over,
});
const page = (items: unknown[], unreadCount = items.length) => HttpResponse.json({ items, nextCursor: null, unreadCount });

const meHandler = http.get('*/api/v1/me', () =>
  HttpResponse.json({ user: { id: 'u', email: 'a@b.c', name: 'Ada Lovelace', emailVerifiedAt: '2026-01-01T00:00:00.000Z' } }),
);

beforeEach(() => {
  FakeES.instances = [];
  toastMock.mockClear();
  toastMock.error.mockClear();
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

describe('notifications page', () => {
  it('lists items with limit badge, price drop reason, delivery state and security text', async () => {
    server.use(
      http.get('*/api/v1/me/notifications', () =>
        page([
          row(3, { payload: matchPayload(3, { limitExceeded: true }) }),
          row(2, { channel: 'TELEGRAM', status: 'FAILED', lastError: 'chat not found', readAt: 'x', payload: matchPayload(2, { reason: 'PRICE_DROP', previousPrice: '1010000' }) }),
          row(1, { kind: 'SECURITY', payload: { type: 'TELEGRAM_LINKED' } }),
        ]),
      ),
    );
    renderWithClient(
      <TooltipProvider>
        <NotificationsView />
      </TooltipProvider>,
    );
    expect(await screen.findByText('Limit aşıldı')).toBeInTheDocument();
    expect(screen.getByText(/Fiyat düştü 1\.010\.000 → 960\.000\s₺/)).toBeInTheDocument();
    expect(screen.getByText(/Telegram · başarısız: chat not found/)).toBeInTheDocument();
    expect(screen.getByText('Telegram hesabınız bağlandı')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Okunmamış' })).toHaveLength(2);
  });

  it('maps error codes to Turkish and clamps long unknown errors', async () => {
    server.use(
      http.get('*/api/v1/me/notifications', () =>
        page([
          row(2, { channel: 'TELEGRAM', status: 'FAILED', lastError: 'CHANNEL_UNAVAILABLE' }),
          row(1, { channel: 'TELEGRAM', status: 'FAILED', lastError: 'x'.repeat(500) }),
        ]),
      ),
    );
    renderWithClient(<TooltipProvider><NotificationsView /></TooltipProvider>);
    expect(await screen.findByText(/Telegram · başarısız: kanal kullanılamıyor/)).toBeInTheDocument();
    expect(screen.queryByText(/x{200}/)).not.toBeInTheDocument();
  });

  it('unread filter requests unread=true', async () => {
    const seen: string[] = [];
    server.use(
      http.get('*/api/v1/me/notifications', ({ request }) => {
        seen.push(new URL(request.url).search);
        return page([row(1)]);
      }),
    );
    renderWithClient(<TooltipProvider><NotificationsView /></TooltipProvider>);
    await screen.findByText(/BMW 3 Serisi/);
    await userEvent.click(screen.getByLabelText('Yalnızca okunmamış'));
    await waitFor(() => expect(seen.some((s) => s.includes('unread=true'))).toBe(true));
  });

  it('"Tümünü okundu yap" posts {all:true} and resets the counter', async () => {
    let body: unknown;
    let read = false;
    server.use(
      http.get('*/api/v1/me/notifications', () => (read ? HttpResponse.json({ items: [], nextCursor: null, unreadCount: 0 }) : page([row(1), row(2)]))),
      http.post('*/api/v1/me/notifications/read', async ({ request }) => {
        body = await request.json();
        read = true;
        return HttpResponse.json({ updated: 2 });
      }),
    );
    const { client } = renderWithClient(<TooltipProvider><NotificationsView /></TooltipProvider>);
    await screen.findByText('2 okunmamış bildirim');
    await userEvent.click(screen.getByRole('button', { name: /Tümünü okundu yap/ }));
    await waitFor(() => expect(body).toEqual({ all: true }));
    await waitFor(() => expect(client.getQueryData(['notifications', 'unread'])).toBe(0));
  });
});

describe('notification bell and live stream', () => {
  const mount = () => {
    server.use(http.get('*/api/v1/me/notifications', () => page([])), meHandler);
    return renderWithClient(
      <TooltipProvider>
        <PanelWithNotifications>
          <div>içerik</div>
        </PanelWithNotifications>
      </TooltipProvider>,
    );
  };

  it('opens with credentials, shows the count after ready, increments on events and toasts', async () => {
    mount();
    expect(FakeES.instances).toHaveLength(1);
    expect(FakeES.instances[0]!.withCredentials).toBe(true);
    const es = FakeES.instances[0]!;
    es.emit('ready', { unreadCount: 3, lastId: 10 });
    await waitFor(() => expect(screen.getByTestId('bell-count')).toHaveTextContent('3'));
    es.emit('notification', row(11));
    expect(await screen.findByRole('button', { name: 'Bildirimler, 4 okunmamış' })).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('Yeni eşleşme', expect.objectContaining({ description: expect.stringContaining('960.000') }));
    expect(screen.getByRole('button', { name: 'Bildirimler, 4 okunmamış' })).toBeInTheDocument();
  });

  it('shows 99+ for large counts', async () => {
    mount();
    FakeES.instances[0]!.emit('ready', { unreadCount: 250, lastId: 900 });
    await waitFor(() => expect(screen.getByTestId('bell-count')).toHaveTextContent('99+'));
  });

  it('rate-limits toasts: 10 events -> 3 toasts and a "+7 yeni eşleşme" summary', async () => {
    mount();
    const es = FakeES.instances[0]!;
    es.emit('ready', { unreadCount: 0, lastId: null });
    for (let i = 1; i <= 10; i++) es.emit('notification', row(i));
    expect(await screen.findByRole('button', { name: 'Bildirimler, 10 okunmamış' })).toBeInTheDocument();
    const normal = toastMock.mock.calls.filter(([m]) => !String(m).startsWith('+'));
    expect(normal).toHaveLength(3);
    expect(toastMock).toHaveBeenLastCalledWith('+7 yeni eşleşme', expect.anything());
  });

  it('opens the panel with the latest items and "Tümünü gör"', async () => {
    server.use(http.get('*/api/v1/me/notifications', () => page([row(5)], 1)), meHandler);
    renderWithClient(
      <TooltipProvider>
        <PanelWithNotifications>
          <div />
        </PanelWithNotifications>
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Bildirimler' }));
    const menu = await screen.findByRole('menu');
    expect(await within(menu).findByText('Yeni eşleşme')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Tümünü gör' })).toHaveAttribute('href', '/app/bildirimler');
  });

  it('SECURITY events bypass the match limiter and keep their own text', async () => {
    mount();
    const es = FakeES.instances[0]!;
    es.emit('ready', { unreadCount: 0, lastId: null });
    for (let i = 1; i <= 4; i++) es.emit('notification', row(i));
    es.emit('notification', row(9, { kind: 'SECURITY', payload: { type: 'TELEGRAM_LINKED' } }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Telegram hesabınız bağlandı', expect.anything()));
    expect(toastMock).toHaveBeenCalledWith('+1 yeni eşleşme', expect.anything());
  });

  it('announces increases only, once, through a status region', async () => {
    mount();
    const es = FakeES.instances[0]!;
    es.emit('ready', { unreadCount: 3, lastId: 10 });
    await screen.findByRole('button', { name: 'Bildirimler, 3 okunmamış' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    es.emit('notification', row(11));
    es.emit('notification', row(12));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('5 okunmamış bildirim'), { timeout: 3000 });
  });

  it('closes the stream on unmount', () => {
    const { unmount } = mount();
    unmount();
    expect(FakeES.instances[0]!.closed).toBe(true);
  });

  it('opens exactly one live connection under StrictMode', () => {
    server.use(http.get('*/api/v1/me/notifications', () => page([])), meHandler);
    renderWithClient(
      <StrictMode>
        <TooltipProvider>
          <PanelWithNotifications>
            <div />
          </PanelWithNotifications>
        </TooltipProvider>
      </StrictMode>,
    );
    expect(FakeES.instances.filter((e) => !e.closed)).toHaveLength(1);
  });

  it('rolls back the counter and shows an error toast when marking read fails', async () => {
    server.use(
      http.get('*/api/v1/me/notifications', () => page([row(1), row(2)])),
      http.post('*/api/v1/me/notifications/read', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 }),
      ),
    );
    const { client } = renderWithClient(<TooltipProvider><NotificationsView /></TooltipProvider>);
    await screen.findByText('2 okunmamış bildirim');
    await userEvent.click(screen.getByRole('button', { name: /Tümünü okundu yap/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(client.getQueryData(['notifications', 'unread'])).toBe(2);
  });

  it('closes the stream on logout', () => {
    mount();
    emitLoggedOut();
    expect(FakeES.instances[0]!.closed).toBe(true);
  });
});
