import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { apiError, ME_ID, meHandler, plansFixture, type TestRole } from '@/test/admin-fixtures';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/admin/kullanicilar',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AdminUsersView } from './users-view';
import { AdminUserDetailView } from './[id]/user-detail-view';

beforeEach(() => {
  toastMock.mockClear();
  toastMock.success.mockClear();
  router.push.mockClear();
});

const userRow = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'ayse@ornek.test', name: 'Ayşe Kaya', role: 'USER', status: 'ACTIVE',
  emailVerifiedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z', lastLoginAt: '2026-10-10T08:00:00.000Z',
  planCode: 'PRO', ...over,
});

describe('users table', () => {
  it('sends filters as request params and resets to page 1', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/plans', () => HttpResponse.json(plansFixture)),
      http.get('*/api/v1/admin/users', ({ request }) => {
        const p = new URL(request.url).searchParams;
        seen.push(p);
        return HttpResponse.json({ total: 45, items: [userRow()] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUsersView />);
    expect(await screen.findByText('Ayşe Kaya')).toBeInTheDocument();
    expect(seen[0]!.get('page')).toBe('1');
    expect(seen[0]!.get('pageSize')).toBe('20');
    expect(seen[0]!.has('status')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    await waitFor(() => expect(seen.at(-1)!.get('page')).toBe('2'));

    await user.selectOptions(screen.getByLabelText('Durum'), 'SUSPENDED');
    await waitFor(() => expect(seen.at(-1)!.get('status')).toBe('SUSPENDED'));
    expect(seen.at(-1)!.get('page')).toBe('1');

    await user.selectOptions(screen.getByLabelText('Rol'), 'ADMIN');
    await waitFor(() => expect(seen.at(-1)!.get('role')).toBe('ADMIN'));

    await user.selectOptions(screen.getByLabelText('Paket'), 'PRO');
    await waitFor(() => expect(seen.at(-1)!.get('plan')).toBe('PRO'));

    await user.type(screen.getByRole('searchbox', { name: 'Ad veya e-posta ara' }), 'ayşe');
    await waitFor(() => expect(seen.at(-1)!.get('q')).toBe('ayşe'));
    const last = seen.at(-1)!;
    expect(last.get('status')).toBe('SUSPENDED');
    expect(last.get('role')).toBe('ADMIN');
    expect(last.get('page')).toBe('1');
  });

  it('shows an empty state for no results and an error state with retry', async () => {
    let fail = true;
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/plans', () => HttpResponse.json(plansFixture)),
      http.get('*/api/v1/admin/users', () =>
        fail ? apiError(500, 'INTERNAL', 'x') : HttpResponse.json({ total: 0, items: [] }),
      ),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUsersView />);
    expect(await screen.findByText('Kullanıcılar yüklenemedi')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(await screen.findByText('Henüz kullanıcı yok')).toBeInTheDocument();
  });
});

function detailHandlers(opts: { role?: TestRole; target?: Record<string, unknown>; subscription?: unknown } = {}) {
  const target = userRow(opts.target);
  return [
    meHandler(opts.role ?? 'ADMIN'),
    http.get('*/api/v1/admin/plans', () => HttpResponse.json(plansFixture)),
    http.get('*/api/v1/admin/users/:id', () =>
      HttpResponse.json({
        user: target,
        subscription:
          opts.subscription === undefined
            ? { planCode: 'PRO', planName: 'Pro', status: 'ACTIVE', endsAt: null, limitOverrides: null }
            : opts.subscription,
        counts: { searchProfiles: 2, activeSessions: 1 },
      }),
    ),
    http.get('*/api/v1/admin/users/:id/usage', () =>
      HttpResponse.json({
        searchProfiles: 2, activeProfiles: 1, notificationsToday: 4, matches7d: 37,
        plan: { code: 'PRO', name: 'Pro', status: 'ACTIVE', endsAt: null, limits: plansFixture.items[1]!.limits },
      }),
    ),
    http.get('*/api/v1/admin/users/:id/search-profiles', () =>
      HttpResponse.json({ items: [{ id: 'sp1', name: 'Günlük BMW', status: 'ACTIVE', make: 'BMW', model: '3 Serisi', channels: ['IN_APP'], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] }),
    ),
    http.get('*/api/v1/admin/users/:id/notifications', () =>
      HttpResponse.json({ total: 1, items: [{ id: 91, kind: 'MATCH', channel: 'TELEGRAM', status: 'FAILED', attempts: 3, lastError: 'CHANNEL_UNAVAILABLE', payload: {}, sentAt: null, readAt: null, latencyMs: null, createdAt: '2026-10-10T08:00:00.000Z' }] }),
    ),
  ];
}

describe('user detail', () => {
  it('suspend asks for confirmation, keeps focus in the dialog and shows the 409 message', async () => {
    let calls = 0;
    server.use(
      ...detailHandlers(),
      http.post('*/api/v1/admin/users/u1/suspend', () => {
        calls += 1;
        return apiError(409, 'INVALID_OPERATION', 'Son süper admin askıya alınamaz');
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUserDetailView id="u1" />);
    await user.click(await screen.findByRole('button', { name: 'Askıya al' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kullanıcı askıya alınsın mı?' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    // Vazgeç: istek gitmez
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Askıya al' }));
    const again = await screen.findByRole('dialog', { name: 'Kullanıcı askıya alınsın mı?' });
    await user.click(within(again).getByRole('button', { name: 'Askıya al' }));
    expect(await within(again).findByRole('alert')).toHaveTextContent('Son süper admin askıya alınamaz');
    expect(calls).toBe(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('subscription form locks IN_APP, validates overrides client-side and sends a valid body', async () => {
    let body: unknown;
    server.use(
      ...detailHandlers(),
      http.patch('*/api/v1/admin/users/u1/subscription', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ planCode: 'PRO', pausedProfiles: 1 });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUserDetailView id="u1" />);
    const form = await screen.findByRole('form', { name: 'Abonelik' });
    await waitFor(() => expect(within(form).getByLabelText('Paket')).toHaveValue('p-pro'));
    expect(within(form).getByRole('option', { name: /Eski paket \(pasif\)/ })).toBeDisabled();

    await user.click(within(form).getByRole('checkbox', { name: 'Bu kullanıcıya özel limitler' }));
    const inApp = within(form).getByRole('checkbox', { name: /Uygulama içi/ });
    expect(inApp).toBeChecked();
    expect(inApp).toBeDisabled();

    const maxProfiles = within(form).getByLabelText('Arama profili');
    await user.clear(maxProfiles);
    await user.type(maxProfiles, '-1');
    await user.click(within(form).getByRole('button', { name: 'Aboneliği kaydet' }));
    expect(await within(form).findByText('0 veya daha büyük bir tam sayı girin')).toBeInTheDocument();
    expect(body).toBeUndefined();

    await user.clear(maxProfiles);
    await user.type(maxProfiles, '5');
    // kanallar paketin kanallarıyla başlar (PRO: IN_APP + TELEGRAM); yalnızca farklıysa gönderilir
    expect(within(form).getByRole('checkbox', { name: 'Telegram' })).toBeChecked();
    await user.click(within(form).getByRole('checkbox', { name: 'E-posta' }));
    await user.click(within(form).getByRole('button', { name: 'Aboneliği kaydet' }));
    await waitFor(() =>
      expect(body).toEqual({
        planId: 'p-pro',
        endsAt: null,
        limitOverrides: { maxSearchProfiles: 5, channels: ['IN_APP', 'TELEGRAM', 'EMAIL'] },
      }),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(String(toastMock.success.mock.calls[0]![1]?.description ?? '')).toContain('1 profil duraklatıldı');
  });

  it('maps a 400 unknown planId to the plan field and 409 inactive plan to a form message', async () => {
    let n = 0;
    server.use(
      ...detailHandlers(),
      http.patch('*/api/v1/admin/users/u1/subscription', () =>
        ++n === 1
          ? apiError(400, 'VALIDATION_FAILED', 'Geçersiz istek', [{ path: ['planId'], message: 'Paket bulunamadı' }])
          : apiError(409, 'INVALID_OPERATION', 'Pasif pakete abonelik atanamaz'),
      ),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUserDetailView id="u1" />);
    const form = await screen.findByRole('form', { name: 'Abonelik' });
    await waitFor(() => expect(within(form).getByLabelText('Paket')).toHaveValue('p-pro'));
    await user.click(within(form).getByRole('button', { name: 'Aboneliği kaydet' }));
    expect(await within(form).findByText('Paket bulunamadı')).toBeInTheDocument();
    expect(within(form).getByLabelText('Paket')).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(form).getByRole('button', { name: 'Aboneliği kaydet' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Pasif pakete abonelik atanamaz');
  });

  it('own account: subscription form and suspend are disabled with an explanation', async () => {
    server.use(...detailHandlers({ target: { id: ME_ID } }));
    renderWithClient(<AdminUserDetailView id={ME_ID} />);
    const form = await screen.findByRole('form', { name: 'Abonelik' });
    expect(within(form).getByText('Kendi aboneliğinizi değiştiremezsiniz.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Aboneliği kaydet' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Askıya al' })).toBeDisabled();
  });

  it('ADMIN does not see role and delete controls; SUPER_ADMIN deletes only after typing the email', async () => {
    server.use(...detailHandlers({ role: 'ADMIN' }));
    const { unmount } = renderWithClient(<AdminUserDetailView id="u1" />);
    await screen.findByRole('button', { name: 'Askıya al' });
    expect(screen.queryByRole('button', { name: 'Kullanıcıyı sil' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Rol')).not.toBeInTheDocument();
    unmount();

    let deleted = false;
    server.use(
      ...detailHandlers({ role: 'SUPER_ADMIN' }),
      http.delete('*/api/v1/admin/users/u1', () => {
        deleted = true;
        return HttpResponse.json({ user: userRow({ status: 'DELETED' }) });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUserDetailView id="u1" />);
    await user.click(await screen.findByRole('button', { name: 'Kullanıcıyı sil' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kullanıcı silinsin mi?' });
    const confirm = within(dialog).getByRole('button', { name: 'Kalıcı olarak sil' });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText(/Onaylamak için/);
    expect(document.activeElement).toBe(input);
    await user.type(input, 'ayse@ornek');
    expect(confirm).toBeDisabled();
    await user.type(input, '.test');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('SUPER_ADMIN changes role through a confirmation', async () => {
    let body: unknown;
    server.use(
      ...detailHandlers({ role: 'SUPER_ADMIN' }),
      http.patch('*/api/v1/admin/users/u1/role', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user: userRow({ role: 'ADMIN' }) });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminUserDetailView id="u1" />);
    await user.selectOptions(await screen.findByLabelText('Rol'), 'ADMIN');
    await user.click(screen.getByRole('button', { name: 'Rolü değiştir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rol değiştirilsin mi?' });
    await user.click(within(dialog).getByRole('button', { name: 'Rolü değiştir' }));
    await waitFor(() => expect(body).toEqual({ role: 'ADMIN' }));
  });
});
