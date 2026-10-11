import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { FakeES, meHandler, overviewFixture } from '@/test/admin-fixtures';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
const nav = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AdminLayoutClient, RequireSuperAdmin } from '@/components/admin/admin-gate';
import { AdminOverviewView } from './overview-view';
import { UserMenu } from '@/components/user-menu';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  FakeES.instances = [];
  toastMock.mockClear();
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
  nav.pathname = '/admin';
  vi.stubGlobal('EventSource', FakeES);
});
afterEach(() => vi.unstubAllGlobals());

const overviewHandler = (over: Record<string, unknown> = {}) =>
  http.get('*/api/v1/admin/overview', () => HttpResponse.json(overviewFixture(over)));
const logsHandler = (items: unknown[] = []) =>
  http.get('*/api/v1/admin/system-logs', () => HttpResponse.json({ total: items.length, items }));

describe('admin guard', () => {
  it('renders a plain 404 view for USER role: no admin shell, no stream, no children', async () => {
    server.use(meHandler('USER'));
    renderWithClient(
      <AdminLayoutClient>
        <p>gizli içerik</p>
      </AdminLayoutClient>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Yönetim menüsü' })).not.toBeInTheDocument();
    expect(screen.queryByText('gizli içerik')).not.toBeInTheDocument();
    expect(screen.queryByText(/yetki/i)).not.toBeInTheDocument();
    expect(FakeES.instances).toHaveLength(0);
  });

  it('ADMIN sees the management nav without Paketler, Ayarlar and Denetim', async () => {
    server.use(meHandler('ADMIN'));
    renderWithClient(
      <AdminLayoutClient>
        <p>içerik</p>
      </AdminLayoutClient>,
    );
    const menu = await screen.findByRole('navigation', { name: 'Yönetim menüsü' });
    for (const label of ['Genel bakış', 'Kullanıcılar', 'İlanlar', 'Analizler', 'Kaynaklar', 'İşler', "Proxy'ler", 'Sistem izleme', 'Bildirimler']) {
      expect(within(menu).getByRole('link', { name: label })).toBeInTheDocument();
    }
    for (const label of ['Paketler', 'Ayarlar', 'Denetim']) {
      expect(within(menu).queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByText('içerik')).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: 'Genel bakış' })).toHaveAttribute('aria-current', 'page');
    expect(FakeES.last().url).toBe('/api/v1/admin/stream');
  });

  it('SUPER_ADMIN also sees Paketler, Ayarlar and Denetim', async () => {
    server.use(meHandler('SUPER_ADMIN'));
    nav.pathname = '/admin/kullanicilar/abc';
    renderWithClient(
      <AdminLayoutClient>
        <p>içerik</p>
      </AdminLayoutClient>,
    );
    const menu = await screen.findByRole('navigation', { name: 'Yönetim menüsü' });
    for (const label of ['Paketler', 'Ayarlar', 'Denetim']) {
      expect(within(menu).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(menu).getByRole('link', { name: 'Kullanıcılar' })).toHaveAttribute('aria-current', 'page');
  });

  it('RequireSuperAdmin renders the 404 view for ADMIN', async () => {
    server.use(meHandler('ADMIN'));
    renderWithClient(
      <RequireSuperAdmin>
        <p>paket formu</p>
      </RequireSuperAdmin>,
    );
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
    expect(screen.queryByText('paket formu')).not.toBeInTheDocument();
  });
});

describe('admin session changes', () => {
  it('role revoked mid-session: error after ready re-checks /me, shows 404, closes the stream and stops reconnecting', async () => {
    let role: 'ADMIN' | 'USER' = 'ADMIN';
    server.use(http.get('*/api/v1/me', () => HttpResponse.json({ user: { id: 'me-1', email: 'a@b.c', name: 'Deniz', role, status: 'ACTIVE' } })));
    renderWithClient(
      <AdminLayoutClient>
        <p>içerik</p>
      </AdminLayoutClient>,
    );
    await screen.findByText('içerik');
    const es = FakeES.last();
    es.emit('ready', overviewFixture());
    role = 'USER'; // sunucu rolü düşürdü ve akışı bitirdi
    es.emit('error', {});
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
    expect(screen.queryByText('içerik')).not.toBeInTheDocument();
    expect(es.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500)); // geri çekilme süresi (≤ 1,2 sn) geçti
    expect(FakeES.instances).toHaveLength(1);
    expect(document.title).toBe('Oto Fırsat');
  });

  it('a failed background /me refetch keeps the workspace mounted and form state intact', async () => {
    let fail = false;
    server.use(
      http.get('*/api/v1/me', () =>
        fail
          ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 })
          : HttpResponse.json({ user: { id: 'me-1', email: 'a@b.c', name: 'Deniz', role: 'ADMIN', status: 'ACTIVE' } }),
      ),
    );
    const { client } = renderWithClient(
      <AdminLayoutClient>
        <input aria-label="Taslak" />
      </AdminLayoutClient>,
    );
    const input = await screen.findByLabelText('Taslak');
    await userEvent.type(input, 'yarım kalan not');
    fail = true;
    await client.invalidateQueries({ queryKey: ['me'] });
    await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('error'));
    expect(screen.getByLabelText('Taslak')).toBe(input);
    expect(input).toHaveValue('yarım kalan not');
    expect(screen.getByRole('navigation', { name: 'Yönetim menüsü' })).toBeInTheDocument();
  });

  it('401 with a transient refresh failure shows a retry after the grace period', async () => {
    let ok = false;
    server.use(
      http.get('*/api/v1/me', () =>
        ok
          ? HttpResponse.json({ user: { id: 'me-1', email: 'a@b.c', name: 'Deniz', role: 'ADMIN', status: 'ACTIVE' } })
          : HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 401 }),
      ),
      http.post('*/api/v1/auth/refresh', () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 503 })),
    );
    renderWithClient(
      <AdminLayoutClient>
        <p>içerik</p>
      </AdminLayoutClient>,
    );
    const retry = await screen.findByRole('button', { name: 'Yeniden dene' }, { timeout: 6_000 });
    ok = true;
    await userEvent.click(retry);
    expect(await screen.findByText('içerik')).toBeInTheDocument();
  }, 10_000);

  it('sets the admin document title only after the gate passes', async () => {
    document.title = 'Oto Fırsat';
    server.use(meHandler('ADMIN'));
    nav.pathname = '/admin/kullanicilar';
    renderWithClient(
      <AdminLayoutClient>
        <p>içerik</p>
      </AdminLayoutClient>,
    );
    await screen.findByText('içerik');
    expect(document.title).toBe('Kullanıcılar · Yönetim · Oto Fırsat');
  });
});

describe('admin overview', () => {
  it('renders KPIs and shows "—" with a hint when Redis-backed fields are null', async () => {
    server.use(meHandler('ADMIN'), overviewHandler({ queues: null, workers: null }), logsHandler());
    renderWithClient(
      <AdminLayoutClient>
        <AdminOverviewView />
      </AdminLayoutClient>,
    );
    const users = await screen.findByRole('group', { name: 'Kullanıcılar' });
    expect(within(users).getByText('1.284')).toBeInTheDocument();
    const workers = screen.getByRole('group', { name: "Worker'lar" });
    expect(within(workers).getByText('—')).toBeInTheDocument();
    expect(within(workers).getByText(/Redis'e ulaşılamıyor/)).toBeInTheDocument();
    expect(screen.getByText(/Kuyruk derinlikleri okunamadı/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Bildirim gecikmesi p95' })).toHaveTextContent('18,4 sn');
    const health = screen.getByRole('region', { name: 'Kaynak sağlığı' });
    expect(within(health).getByText('partner-feed')).toBeInTheDocument();
    expect(within(health).getByText('Çalışmıyor')).toBeInTheDocument();
  });

  it('source health tells an admin pause from a block pause', async () => {
    server.use(
      meHandler('ADMIN'),
      overviewHandler({
        sources: [
          { id: 1, code: 'durdurulan', health: 'HEALTHY', isActive: false, lastSuccessAt: null },
          { id: 2, code: 'engelli', health: 'PAUSED', isActive: true, lastSuccessAt: null },
        ],
      }),
      logsHandler(),
    );
    renderWithClient(
      <AdminLayoutClient>
        <AdminOverviewView />
      </AdminLayoutClient>,
    );
    const health = await screen.findByRole('region', { name: 'Kaynak sağlığı' });
    const stopped = within(health).getByText('durdurulan').closest('li') as HTMLElement;
    expect(within(stopped).getByText('Duraklatıldı (yönetici)')).toBeInTheDocument();
    const blocked = within(health).getByText('engelli').closest('li') as HTMLElement;
    expect(within(blocked).getByText('Engel nedeniyle duraklatıldı')).toBeInTheDocument();
  });

  it('stream alert shows a toast and is prepended to the recent alerts list; kpi updates tiles', async () => {
    server.use(
      meHandler('ADMIN'),
      overviewHandler(),
      logsHandler([{ id: 7, level: 'WARN', component: 'monitor', message: 'Eski uyarı', context: null, createdAt: '2026-10-11T08:00:00.000Z' }]),
    );
    renderWithClient(
      <AdminLayoutClient>
        <AdminOverviewView />
      </AdminLayoutClient>,
    );
    const alerts = await screen.findByRole('region', { name: 'Son alarmlar' });
    expect(await within(alerts).findByText('Eski uyarı')).toBeInTheDocument();

    const es = FakeES.last();
    es.emit('ready', overviewFixture());
    es.emit('alert', { type: 'alert', key: 'source:2:down', level: 'ERROR', message: 'partner-feed kaynağı çalışmıyor', at: '2026-10-11T10:00:00.000Z' });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0]![0]).toBe('partner-feed kaynağı çalışmıyor');
    const items = within(alerts).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('partner-feed kaynağı çalışmıyor');
    expect(items[1]).toHaveTextContent('Eski uyarı');

    // aynı olay tekrar gelirse yinelenmez
    es.emit('alert', { type: 'alert', key: 'source:2:down', level: 'ERROR', message: 'partner-feed kaynağı çalışmıyor', at: '2026-10-11T10:00:00.000Z' });
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(within(alerts).getAllByRole('listitem')).toHaveLength(2);

    es.emit('kpi', {
      notifications: { sentToday: 6001, failedToday: 14, skippedLimitToday: 61 },
      queues: { scrape: 0, analyze: 0, match: 0, notify: 0, 'notify-telegram': 0 },
      workers: { alive: 2, dead: 1 },
      sources: overviewFixture().sources,
    });
    await waitFor(() => expect(screen.getByRole('group', { name: 'Gönderilen bildirim (bugün)' })).toHaveTextContent('6.001'));
    expect(screen.getByRole('group', { name: "Worker'lar" })).toHaveTextContent('1 yanıt vermiyor');
  });
});

describe('user menu', () => {
  it('shows "Yönetim paneli" only to admins', async () => {
    server.use(meHandler('ADMIN'));
    const { unmount } = renderWithClient(<UserMenu />);
    await userEvent.click(await screen.findByRole('button', { name: /Hesap menüsü: Deniz Yönetici/ }));
    expect(await screen.findByRole('menuitem', { name: 'Yönetim paneli' })).toHaveAttribute('href', '/admin');
    unmount();

    server.use(meHandler('USER'));
    renderWithClient(<UserMenu />);
    await userEvent.click(await screen.findByRole('button', { name: /Hesap menüsü: Deniz Yönetici/ }));
    await screen.findByRole('menuitem', { name: 'Çıkış' });
    expect(screen.queryByRole('menuitem', { name: 'Yönetim paneli' })).not.toBeInTheDocument();
  });
});
