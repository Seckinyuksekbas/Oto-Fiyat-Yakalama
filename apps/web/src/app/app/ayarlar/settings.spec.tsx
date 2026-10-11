import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/app/ayarlar',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

import { maskIp, shortUserAgent } from '@/lib/device';
import { SubscriptionView } from '../abonelik/subscription-view';
import { AccountView } from './account-view';
import { ChannelsView } from './kanallar/channels-view';
import { SecurityView } from './guvenlik/security-view';

const err = (status: number, code: string) =>
  HttpResponse.json({ error: { code, message: code } }, { status });

const me = (verified = true) => ({
  user: { id: 'u1', email: 'a@b.com', name: 'Ayşe', emailVerifiedAt: verified ? '2026-10-01T00:00:00Z' : null },
  subscription: { planCode: 'FREE', planName: 'Ücretsiz', status: 'ACTIVE', endsAt: null },
  usage: { searchProfiles: 1, notificationsToday: 3 },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('device helpers', () => {
  it('masks IPv4 and IPv6 and handles null', () => {
    expect(maskIp('88.247.12.34')).toBe('88.247.x.x');
    expect(maskIp('2a01:4f8:c17:1234::1')).toBe('2a01:4f8:x:x');
    expect(maskIp(null)).toBe('Bilinmiyor');
    expect(maskIp('::ffff:88.247.12.34')).toBe('88.247.x.x');
    expect(maskIp('::1')).toBe('::1 (yerel)');
    expect(maskIp('2a01:4f8::1')).toBe('2a01:4f8:x:x');
    expect(maskIp('::abcd:1')).toBe('::x:x');
    expect(maskIp('fe80::1%eth0')).toBe('fe80:x:x');
    expect(maskIp('garbage')).toBe('Bilinmiyor');
  });
  it('shortens user agents', () => {
    expect(
      shortUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'),
    ).toBe('Chrome · Windows');
    expect(shortUserAgent(null)).toBe('Bilinmeyen cihaz');
  });
});

describe('SubscriptionView', () => {
  const view = (over: object = {}) => ({
    planCode: 'FREE',
    planName: 'Ücretsiz',
    status: 'ACTIVE',
    endsAt: null,
    limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 20, channels: ['IN_APP', 'TELEGRAM'], opportunitiesDelayHours: 0 },
    usage: { searchProfiles: 1, notificationsToday: 5 },
    ...over,
  });

  it('shows "Ücretsiz plan" for FALLBACK status', async () => {
    server.use(http.get('*/api/v1/me/subscription', () => HttpResponse.json(view({ status: 'FALLBACK' }))));
    renderWithClient(<SubscriptionView />);
    expect(await screen.findByText('Ücretsiz plan')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /Arama profili/ })).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByRole('progressbar', { name: /Arama profili/ })).toHaveAttribute('aria-valuetext', '1 / 2');
    for (const b of screen.getAllByRole('button', { name: /yükselt/i })) expect(b).toBeDisabled();
  });

  it('lists plan comparison with seeded limits', async () => {
    server.use(http.get('*/api/v1/me/subscription', () => HttpResponse.json(view())));
    renderWithClient(<SubscriptionView />);
    expect(await screen.findByText('Mevcut planınız')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Business' })).toBeInTheDocument();
    expect(screen.getByText('2.000')).toBeInTheDocument();
  });
});

describe('AccountView', () => {
  it('updates name', async () => {
    let body: unknown;
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json(me())),
      http.patch('*/api/v1/me', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user: me().user });
      }),
    );
    renderWithClient(<AccountView />);
    const input = await screen.findByLabelText('Ad soyad');
    await userEvent.clear(input);
    await userEvent.type(input, 'Ayşe Yılmaz');
    await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(body).toEqual({ name: 'Ayşe Yılmaz' }));
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
  });

  it('does not submit delete dialog without a password', async () => {
    const del = vi.fn();
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json(me())),
      http.delete('*/api/v1/me', () => {
        del();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<AccountView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Hesabı sil' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hesabımı kalıcı olarak sil' }));
    expect(await screen.findByText('Onaylamak için şifrenizi girin')).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it('shows rate limit message on 429 and redirects on success', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/v1/me', () => HttpResponse.json(me())),
      http.delete('*/api/v1/me', () => {
        calls += 1;
        return calls === 1 ? err(429, 'RATE_LIMITED') : new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<AccountView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Hesabı sil' }));
    await userEvent.type(screen.getByLabelText('Şifreniz'), 'secret-pass-1');
    await userEvent.click(screen.getByRole('button', { name: 'Hesabımı kalıcı olarak sil' }));
    expect(await screen.findByText(/Çok fazla deneme/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Hesabımı kalıcı olarak sil' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(toastMock.success).toHaveBeenCalledWith('Hesap silindi');
  });
});

describe('SecurityView', () => {
  const sessions = {
    items: [
      { id: 's1', ip: '88.247.12.34', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36', lastUsedAt: new Date().toISOString(), current: true },
      { id: 's2', ip: '5.6.7.8', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', lastUsedAt: new Date().toISOString(), current: false },
    ],
  };

  it('lists sessions with masked IP and current tag; revokes one', async () => {
    const revoked: string[] = [];
    server.use(
      http.get('*/api/v1/me/sessions', () => HttpResponse.json(sessions)),
      http.delete('*/api/v1/me/sessions/:id', ({ params }) => {
        revoked.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<SecurityView />);
    expect(await screen.findByText('88.247.x.x')).toBeInTheDocument();
    expect(screen.getByText('Bu cihaz')).toBeInTheDocument();
    expect(screen.queryByText('88.247.12.34')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Oturumu kapat/ }));
    await waitFor(() => expect(revoked).toEqual(['s2']));
  });

  it('closes all other sessions', async () => {
    const revoked: string[] = [];
    server.use(
      http.get('*/api/v1/me/sessions', () => HttpResponse.json(sessions)),
      http.delete('*/api/v1/me/sessions/:id', ({ params }) => {
        revoked.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<SecurityView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Diğer oturumları kapat' }));
    await waitFor(() => expect(revoked).toEqual(['s2']));
  });

  it('reports failures when closing other sessions', async () => {
    server.use(
      http.get('*/api/v1/me/sessions', () => HttpResponse.json(sessions)),
      http.delete('*/api/v1/me/sessions/:id', () => err(500, 'INTERNAL')),
    );
    renderWithClient(<SecurityView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Diğer oturumları kapat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 oturum kapatılamadı/);
  });

  const fill = async (cur: string, next: string) => {
    await userEvent.type(await screen.findByLabelText('Mevcut şifre'), cur);
    await userEvent.type(screen.getByLabelText('Yeni şifre'), next);
    await userEvent.click(screen.getByRole('button', { name: 'Şifreyi değiştir' }));
  };

  it('maps password errors and shows success note', async () => {
    let n = 0;
    server.use(
      http.get('*/api/v1/me/sessions', () => HttpResponse.json(sessions)),
      http.post('*/api/v1/me/change-password', () => {
        n += 1;
        if (n === 1) return err(400, 'INVALID_CREDENTIALS');
        if (n === 2) return err(429, 'RATE_LIMITED');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<SecurityView />);
    await fill('old-password', 'new-password-123');
    expect(await screen.findByText('Mevcut şifre hatalı')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Şifreyi değiştir' }));
    expect(await screen.findByText(/Çok fazla deneme/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Şifreyi değiştir' }));
    expect(await screen.findByText(/diğer oturumlarınız kapatıldı/i)).toBeInTheDocument();
  });

  it('rejects short new password client-side', async () => {
    const post = vi.fn();
    server.use(
      http.get('*/api/v1/me/sessions', () => HttpResponse.json(sessions)),
      http.post('*/api/v1/me/change-password', () => {
        post();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<SecurityView />);
    await fill('old-password', 'short');
    expect(await screen.findByRole('alert')).toHaveTextContent('En az 10 karakter olmalı');
    expect(screen.getByLabelText('Yeni şifre')).toHaveAttribute('aria-invalid', 'true');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('ChannelsView', () => {
  const channels = (tg: object = {}, telegramAvailable = true) => ({
    items: [
      { type: 'IN_APP', isVerified: true, isEnabled: true },
      { type: 'TELEGRAM', linked: false, isVerified: false, isEnabled: false, ...tg },
    ],
    telegramAvailable,
  });
  const useMe = (verified = true, planChannels: string[] = ['IN_APP', 'TELEGRAM']) => [
    http.get('*/api/v1/me', () => HttpResponse.json(me(verified))),
    http.get('*/api/v1/me/subscription', () =>
      HttpResponse.json({
        planCode: 'FREE',
        planName: 'Ücretsiz',
        status: 'ACTIVE',
        endsAt: null,
        limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 20, channels: planChannels, opportunitiesDelayHours: 0 },
        usage: { searchProfiles: 0, notificationsToday: 0 },
      }),
    ),
  ];

  it('telegram unavailable', async () => {
    server.use(...useMe(), http.get('*/api/v1/me/channels', () => HttpResponse.json(channels({}, false))));
    renderWithClient(<ChannelsView />);
    expect(await screen.findByText('Telegram bildirimleri şu anda kullanılamıyor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Telegram'ı bağla" })).not.toBeInTheDocument();
  });

  it('linked user keeps toggle and unlink when bot is unavailable', async () => {
    server.use(
      ...useMe(),
      http.get('*/api/v1/me/channels', () =>
        HttpResponse.json(channels({ linked: true, isVerified: true, isEnabled: true }, false)),
      ),
    );
    renderWithClient(<ChannelsView />);
    expect(await screen.findByRole('switch', { name: 'Telegram bildirimleri' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Bağlantıyı kaldır' })).toBeInTheDocument();
    expect(screen.getByText(/yeni bağlantı oluşturulamaz/)).toBeInTheDocument();
  });

  it('plan without Telegram is explained up front', async () => {
    server.use(...useMe(true, ['IN_APP']), http.get('*/api/v1/me/channels', () => HttpResponse.json(channels())));
    renderWithClient(<ChannelsView />);
    expect(await screen.findByText(/planınız Telegram bildirimlerini içermiyor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Telegram'ı bağla" })).not.toBeInTheDocument();
  });

  it('linked user after downgrade sees an explanation', async () => {
    server.use(
      ...useMe(true, ['IN_APP']),
      http.get('*/api/v1/me/channels', () =>
        HttpResponse.json(channels({ linked: true, isVerified: true, isEnabled: true })),
      ),
    );
    renderWithClient(<ChannelsView />);
    expect(await screen.findByText(/Planınız artık Telegram bildirimlerini içermiyor/)).toBeInTheDocument();
  });

  it('unverified account needs verification', async () => {
    server.use(...useMe(false), http.get('*/api/v1/me/channels', () => HttpResponse.json(channels())));
    renderWithClient(<ChannelsView />);
    expect(await screen.findByText(/Telegram bağlamak için e-posta adresinizi doğrulayın/)).toBeInTheDocument();
  });

  const linkedChannels = () =>
    http.get('*/api/v1/me/channels', () =>
      HttpResponse.json(channels({ linked: true, isVerified: true, isEnabled: true })),
    );

  it('linked: toggles and unlinks with confirmation; cancel does not unlink', async () => {
    let patched: unknown;
    let removed = false;
    server.use(
      ...useMe(),
      linkedChannels(),
      http.patch('*/api/v1/me/channels/TELEGRAM', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ type: 'TELEGRAM' });
      }),
      http.delete('*/api/v1/me/channels/telegram', () => {
        removed = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<ChannelsView />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Telegram bildirimleri' }));
    await waitFor(() => expect(patched).toEqual({ isEnabled: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Bağlantıyı kaldır' }));
    await userEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(removed).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Bağlantıyı kaldır' }));
    await userEvent.click(screen.getByRole('button', { name: 'Evet, kaldır' }));
    await waitFor(() => expect(removed).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('unlink failure keeps the dialog open with an error', async () => {
    server.use(
      ...useMe(),
      linkedChannels(),
      http.delete('*/api/v1/me/channels/telegram', () => err(500, 'INTERNAL')),
    );
    renderWithClient(<ChannelsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantıyı kaldır' }));
    await userEvent.click(screen.getByRole('button', { name: 'Evet, kaldır' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/sorun oluştu/);
  });

  it('toggle failure shows an error', async () => {
    server.use(...useMe(), linkedChannels(), http.patch('*/api/v1/me/channels/TELEGRAM', () => err(500, 'INTERNAL')));
    renderWithClient(<ChannelsView />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Telegram bildirimleri' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/sorun oluştu/);
  });

  it.each([
    [403, 'EMAIL_NOT_VERIFIED', /e-posta adresinizi doğrulayın/],
    [403, 'LIMIT_REACHED', /planınız Telegram bildirimlerini içermiyor/],
    [503, 'FEATURE_DISABLED', /Telegram bildirimleri şu anda kullanılamıyor/],
  ])('link error %s %s', async (status, code, text) => {
    server.use(
      ...useMe(),
      http.get('*/api/v1/me/channels', () => HttpResponse.json(channels())),
      http.post('*/api/v1/me/channels/telegram/link', () => err(status, code)),
    );
    renderWithClient(<ChannelsView />);
    await userEvent.click(await screen.findByRole('button', { name: "Telegram'ı bağla" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('rejects a deepLink that is not a t.me https link', async () => {
    server.use(
      ...useMe(),
      http.get('*/api/v1/me/channels', () => HttpResponse.json(channels())),
      http.post('*/api/v1/me/channels/telegram/link', () =>
        HttpResponse.json(
          { deepLink: 'https://evil.example/x', expiresAt: new Date(Date.now() + 600_000).toISOString() },
          { status: 201 },
        ),
      ),
    );
    renderWithClient(<ChannelsView />);
    await userEvent.click(await screen.findByRole('button', { name: "Telegram'ı bağla" }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/oluşturulamadı/);
    expect(screen.queryByRole('link', { name: /Telegram'ı aç/ })).not.toBeInTheDocument();
  });

  describe('linking flow', () => {
    // Yalnızca aralık zamanlayıcıları ve saat sahte: ağ (MSW) gerçek zamanlayıcılarla çalışır.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    const linkHandler = (ttlMs: number) =>
      http.post('*/api/v1/me/channels/telegram/link', () =>
        HttpResponse.json(
          { deepLink: 'https://t.me/bot?start=abc', expiresAt: new Date(Date.now() + ttlMs).toISOString() },
          { status: 201 },
        ),
      );

    it('counts down, polls and shows success', async () => {
      let linked = false;
      server.use(
        ...useMe(),
        http.get('*/api/v1/me/channels', () =>
          HttpResponse.json(channels(linked ? { linked: true, isVerified: true, isEnabled: true } : {})),
        ),
        linkHandler(600_000),
      );
      renderWithClient(<ChannelsView />);
      await userEvent.click(await screen.findByRole('button', { name: "Telegram'ı bağla" }));
      const open = await screen.findByRole('link', { name: /Telegram'ı aç/ });
      expect(open).toHaveAttribute('href', 'https://t.me/bot?start=abc');
      expect(open).toHaveAttribute('target', '_blank');
      expect(open.getAttribute('rel')).toContain('noopener');
      expect(screen.getByText(/Bağlantı bekleniyor/)).toBeInTheDocument();
      expect(screen.getByText('10:00')).toBeInTheDocument();
      await advance(3000);
      expect(screen.getByText('09:57')).toBeInTheDocument();

      linked = true;
      await advance(5000);
      await screen.findByText('Bağlandı');
      expect(toastMock.success).toHaveBeenCalledWith('Telegram bağlandı');
      expect(screen.queryByText(/Bağlantı bekleniyor/)).not.toBeInTheDocument();
    });

    it('expires and offers a new link', async () => {
      server.use(...useMe(), http.get('*/api/v1/me/channels', () => HttpResponse.json(channels())), linkHandler(10_000));
      renderWithClient(<ChannelsView />);
      await userEvent.click(await screen.findByRole('button', { name: "Telegram'ı bağla" }));
      await screen.findByText(/Bağlantı bekleniyor/);
      await advance(11_000);
      expect(await screen.findByRole('button', { name: 'Yeni bağlantı oluştur' })).toBeInTheDocument();
      expect(screen.queryByText(/Bağlantı bekleniyor/)).not.toBeInTheDocument();
    });

    it('does a final refetch at expiry and catches a late link', async () => {
      let linked = false;
      server.use(
        ...useMe(),
        http.get('*/api/v1/me/channels', () =>
          HttpResponse.json(channels(linked ? { linked: true, isVerified: true, isEnabled: true } : {})),
        ),
        linkHandler(7_000),
      );
      renderWithClient(<ChannelsView />);
      await userEvent.click(await screen.findByRole('button', { name: "Telegram'ı bağla" }));
      await screen.findByText(/Bağlantı bekleniyor/);
      await advance(6_000); // 5 sn'lik yoklama bağlı değil görür
      linked = true; // ikinci yoklamadan önce bağlanır
      await advance(2_000); // süre dolar, son yenileme çalışır
      await screen.findByText('Bağlandı');
      expect(toastMock.success).toHaveBeenCalledWith('Telegram bağlandı');
      expect(screen.queryByRole('button', { name: 'Yeni bağlantı oluştur' })).not.toBeInTheDocument();
    });

    it('stops polling on unmount', async () => {
      let polls = 0;
      server.use(
        ...useMe(),
        http.get('*/api/v1/me/channels', () => {
          polls += 1;
          return HttpResponse.json(channels());
        }),
        linkHandler(600_000),
      );
      const { unmount } = renderWithClient(<ChannelsView />);
      await userEvent.click(await screen.findByRole('button', { name: "Telegram'ı bağla" }));
      await screen.findByText(/Bağlantı bekleniyor/);
      await advance(5_100);
      await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2));
      unmount();
      const after = polls;
      await advance(20_000);
      expect(polls).toBe(after);
    });
  });
});
