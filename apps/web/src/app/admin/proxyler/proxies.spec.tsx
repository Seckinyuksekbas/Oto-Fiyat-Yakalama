import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { apiError, meHandler } from '@/test/admin-fixtures';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/proxyler',
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminProxiesView } from './proxies-view';

beforeEach(() => {
  toastMock.error.mockClear();
  toastMock.success.mockClear();
});

const SECRET_URL = 'http://ali:S3cr3tParola@proxy.example:8080';

const proxy = (over: Record<string, unknown> = {}) => ({
  id: 3,
  name: 'Çıkış A',
  url: 'http://***@proxy.example:8080',
  isEnabled: true,
  lastCheckAt: '2026-10-11T08:00:00.000Z',
  lastLatencyMs: 182,
  lastError: null,
  sourceCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

function expectNoSecret(client: import('@tanstack/react-query').QueryClient) {
  expect(document.body.innerHTML).not.toContain('S3cr3tParola');
  for (const input of Array.from(document.querySelectorAll('input'))) expect(input.value).not.toContain('S3cr3tParola');
  const cached = JSON.stringify([
    client.getQueryCache().getAll().map((q) => q.state.data),
    client.getMutationCache().getAll().map((m) => m.state.variables),
  ]);
  expect(cached).not.toContain('S3cr3tParola');
}

describe('proxies', () => {
  it('creates a proxy, clears the address input and never renders the plain URL', async () => {
    const items = [proxy()];
    let body: Record<string, unknown> | undefined;
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/proxies', () => HttpResponse.json({ total: items.length, items })),
      http.post('*/api/v1/admin/proxies', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        const created = proxy({ id: 4, name: 'Çıkış B', url: 'http://***@proxy.example:8080', lastCheckAt: null, lastLatencyMs: null, sourceCount: 0 });
        items.push(created);
        return HttpResponse.json({ proxy: created }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { client } = renderWithClient(<AdminProxiesView />);
    expect(await screen.findByText('Çıkış A')).toBeInTheDocument();
    expect(screen.getAllByText('http://***@proxy.example:8080').length).toBeGreaterThan(0);
    expect(screen.getByText('182 ms')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Yeni proxy' });
    await user.type(within(form).getByLabelText('Ad'), 'Çıkış B');
    await user.type(within(form).getByLabelText('Proxy adresi'), SECRET_URL);
    await user.click(within(form).getByRole('button', { name: 'Proxy ekle' }));

    await waitFor(() => expect(body).toEqual({ name: 'Çıkış B', url: SECRET_URL, isEnabled: true }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Proxy eklendi'));
    expect(await screen.findByText('Çıkış B')).toBeInTheDocument();
    expect(within(form).getByLabelText('Proxy adresi')).toHaveValue('');
    expectNoSecret(client);
  });

  it('clears the address even when the server rejects it', async () => {
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/proxies', () => HttpResponse.json({ total: 0, items: [] })),
      // Gerçek biçim: SSRF reddi ayrıntısız VALIDATION_FAILED + Türkçe mesaj (assertPublicHttpUrl)
      http.post('*/api/v1/admin/proxies', () => apiError(400, 'VALIDATION_FAILED', 'İç ağ adresi kullanılamaz')),
    );
    const user = userEvent.setup();
    const { client } = renderWithClient(<AdminProxiesView />);
    const form = await screen.findByRole('form', { name: 'Yeni proxy' });
    await user.type(within(form).getByLabelText('Ad'), 'İç');
    await user.type(within(form).getByLabelText('Proxy adresi'), SECRET_URL);
    await user.click(within(form).getByRole('button', { name: 'Proxy ekle' }));
    expect(await within(form).findByText('İç ağ adresi kullanılamaz')).toBeInTheDocument();
    expect(within(form).getByLabelText('Proxy adresi')).toHaveAccessibleDescription('İç ağ adresi kullanılamaz');
    expect(within(form).getByLabelText('Proxy adresi')).toHaveValue('');
    expectNoSecret(client);
  });

  it('edits without resending the URL unless a new one is typed', async () => {
    let patch: Record<string, unknown> | undefined;
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/proxies', () => HttpResponse.json({ total: 1, items: [proxy()] })),
      http.patch('*/api/v1/admin/proxies/3', async ({ request }) => {
        patch = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ proxy: proxy({ name: 'Çıkış A2' }) });
      }),
    );
    const user = userEvent.setup();
    const { client } = renderWithClient(<AdminProxiesView />);
    await user.click(await screen.findByRole('button', { name: 'Çıkış A düzenle' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Yeni proxy adresi/)).toHaveValue('');
    const name = within(dialog).getByLabelText('Ad');
    await user.clear(name);
    await user.type(name, 'Çıkış A2');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(patch).toEqual({ name: 'Çıkış A2' }));
    expectNoSecret(client);
  });

  it('shows the check result latency, Turkish errors and the throttle message', async () => {
    let calls = 0;
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/proxies', () => HttpResponse.json({ total: 1, items: [proxy({ lastLatencyMs: null, lastCheckAt: null })] })),
      http.post('*/api/v1/admin/proxies/3/check', () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ proxy: proxy({ lastLatencyMs: null, lastError: 'Zaman aşımı (10 sn)' }) });
        return apiError(429, 'RATE_LIMITED', 'Proxy kontrolü 10 saniyede en fazla 1 kez yapılabilir');
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminProxiesView />);
    await user.click(await screen.findByRole('button', { name: 'Çıkış A kontrol et' }));
    expect(await screen.findByText('Zaman aşımı (10 sn)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Çıkış A kontrol et' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('10 saniyede')));
  });
});
