import { delay, http, HttpResponse } from 'msw';
import { previewSearchProfileSchema } from '@oto/shared';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const push = vi.fn();
const replace = vi.fn();
let params: Record<string, string> = { id: 'p1' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => '/app/profiller',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => params,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ProfilesPage from './page';
import NewProfilePage from './yeni/page';
import EditProfilePage from './[id]/page';

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'BMW fırsatları',
  status: 'ACTIVE',
  make: 'BMW',
  model: null,
  yearMin: 2016,
  yearMax: null,
  priceMin: null,
  priceMax: '1500000',
  kmMax: 120000,
  fuels: ['DIESEL'],
  transmissions: [],
  cities: ['İstanbul'],
  minDiscountPct: 0.2,
  minConfidence: 'MEDIUM',
  excludeDamaged: true,
  notifyOnPriceDrop: true,
  priceDropPct: 0.05,
  notifyOnRelist: false,
  channels: ['IN_APP'],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

interface Setup {
  verified?: boolean;
  max?: number;
  planChannels?: string[];
  telegramLinked?: boolean;
  telegramAvailable?: boolean;
  profiles?: ReturnType<typeof profile>[];
}

let previewBodies: unknown[] = [];
let postBodies: unknown[] = [];
let patchBodies: unknown[] = [];
let previewInvalid: unknown[] = [];

function mockApi(s: Setup = {}) {
  const { verified = true, max = 3, planChannels = ['IN_APP', 'TELEGRAM'], telegramLinked = true, telegramAvailable = true } = s;
  const profiles = s.profiles ?? [];
  server.use(
    http.get('*/api/v1/me', () =>
      HttpResponse.json({
        user: { id: 'u1', email: 'a@b.c', name: 'A', emailVerifiedAt: verified ? '2026-10-01T00:00:00.000Z' : null },
        subscription: { planCode: 'FREE', planName: 'Ücretsiz', status: 'ACTIVE', endsAt: null, limits: { maxSearchProfiles: max, channels: planChannels } },
        usage: { searchProfiles: profiles.length, notificationsToday: 0 },
      }),
    ),
    http.get('*/api/v1/me/channels', () =>
      HttpResponse.json({
        items: [
          { type: 'IN_APP', isVerified: true, isEnabled: true },
          { type: 'TELEGRAM', linked: telegramLinked, isVerified: telegramLinked, isEnabled: telegramLinked },
        ],
        telegramAvailable,
      }),
    ),
    http.get('*/api/v1/catalog/makes', () => HttpResponse.json({ items: [{ make: 'BMW', count: 10 }, { make: 'Audi', count: 4 }] })),
    http.get('*/api/v1/catalog/makes/:make/models', () => HttpResponse.json({ items: [{ model: '3 Serisi', count: 6 }] })),
    http.post('*/api/v1/me/search-profiles/preview', async ({ request }) => {
      const body = await request.json();
      previewBodies.push(body);
      if (!previewSearchProfileSchema.safeParse(body).success) {
        previewInvalid.push(body);
        return HttpResponse.json({ error: { code: 'VALIDATION_FAILED', message: 'x' } }, { status: 400 });
      }
      return HttpResponse.json({
        estimatedDailyMatches: 2.4,
        items: [
          {
            id: 9, title: 'x', make: 'BMW', model: '3 Serisi', year: 2019, km: 80000, city: 'Ankara', price: '960000',
            imageUrl: null, url: 'https://example.com/9', firstSeenAt: new Date().toISOString(),
            analysis: { opportunityScore: 77, confidence: 'HIGH', discountPct: 0.2, estimatedPrice: '1200000' },
          },
        ],
      });
    }),
    http.get('*/api/v1/me/search-profiles', () => HttpResponse.json({ items: profiles })),
  );
}

const user = () => userEvent.setup();

beforeEach(() => {
  push.mockReset();
  previewBodies = [];
  postBodies = [];
  patchBodies = [];
  previewInvalid = [];
  params = { id: 'p1' };
});

async function goStep(u: ReturnType<typeof userEvent.setup>, n: number) {
  for (let i = 1; i < n; i++) await u.click(await screen.findByRole('button', { name: /^devam$/i }));
}

describe('wizard: oluşturma', () => {
  it('"Tüm yeni ilanlar" güven alanını gizler ve minDiscountPct: 0 gönderir', async () => {
    mockApi();
    server.use(
      http.post('*/api/v1/me/search-profiles', async ({ request }) => {
        postBodies.push(await request.json());
        return HttpResponse.json(profile(), { status: 201 });
      }),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 2);

    expect(await screen.findByText('Minimum güven')).toBeInTheDocument();
    await u.click(screen.getByRole('radio', { name: /tüm yeni ilanlar/i }));
    expect(screen.queryByText('Minimum güven')).not.toBeInTheDocument();
    expect(screen.getByText(/güven koşulu uygulanmaz/i)).toBeInTheDocument();

    await goStep(u, 2);
    await u.type(await screen.findByLabelText('Profil adı'), 'Hepsi');
    await u.click(screen.getByRole('button', { name: /profili oluştur/i }));

    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({ name: 'Hepsi', minDiscountPct: 0, channels: ['IN_APP'] });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/profiller'));
  });

  it('hızlı üç değişiklik tek önizleme isteği üretir', async () => {
    mockApi();
    const u = user();
    renderWithClient(<NewProfilePage />);
    await waitFor(() => expect(previewBodies).toHaveLength(1), { timeout: 3000 });
    expect(await screen.findByText('~2,4')).toBeInTheDocument();

    await u.type(screen.getByLabelText('Azami km'), '123');
    await waitFor(() => expect(previewBodies).toHaveLength(2), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 700));
    expect(previewBodies).toHaveLength(2);
    expect(previewBodies[1]).toMatchObject({ kmMax: 123 });
    expect(previewInvalid).toEqual([]);
  });

  it('LIMIT_REACHED (e-posta doğrulanmamış) uyarı gösterir ve form verisini korur', async () => {
    mockApi({ verified: false });
    server.use(
      http.post('*/api/v1/me/search-profiles', () =>
        HttpResponse.json(
          { error: { code: 'LIMIT_REACHED', message: 'x', details: { limit: 1, reason: 'EMAIL_NOT_VERIFIED' } } },
          { status: 403 },
        ),
      ),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await u.type(await screen.findByLabelText('Azami km'), '90000');
    await goStep(u, 3);
    await u.type(await screen.findByLabelText('Profil adı'), 'Benim profilim');
    await u.click(screen.getByRole('button', { name: /profili oluştur/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/e-postanızı doğrulayana kadar/i);
    expect(screen.getByLabelText('Profil adı')).toHaveValue('Benim profilim');
    await u.click(screen.getByRole('button', { name: /^geri$/i }));
    await u.click(screen.getByRole('button', { name: /^geri$/i }));
    expect(await screen.findByLabelText('Azami km')).toHaveValue('90000');
  });

  it('plan Telegram içermiyorsa seçenek devre dışıdır ve açıklama görünür', async () => {
    mockApi({ planChannels: ['IN_APP'] });
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 3);
    const sw = await screen.findByRole('switch', { name: /telegram/i });
    expect(sw).toBeDisabled();
    expect(screen.getByText(/planınız telegram bildirimlerini içermiyor/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /uygulama içi/i })).toBeDisabled();
  });

  it('Telegram bağlı değilse ayarlara bağlantı verir', async () => {
    mockApi({ telegramLinked: false });
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 3);
    expect(await screen.findByRole('switch', { name: /telegram/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /ayarlar'dan bağlayın/i })).toHaveAttribute('href', '/app/ayarlar/kanallar');
  });

  it('VALIDATION_FAILED ayrıntılarını alan hatasına çevirir', async () => {
    mockApi();
    server.use(
      http.post('*/api/v1/me/search-profiles', () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'x', details: [{ path: 'name', message: 'Ad çok kısa' }] } },
          { status: 400 },
        ),
      ),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 3);
    await u.type(await screen.findByLabelText('Profil adı'), 'A');
    await u.click(screen.getByRole('button', { name: /profili oluştur/i }));
    expect(await screen.findByText('Ad çok kısa')).toBeInTheDocument();
  });
});

describe('wizard: ek davranışlar', () => {
  it('"Tüm yeni ilanlar" önizleme gövdesinde minConfidence göndermez', async () => {
    mockApi();
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 2);
    await u.click(await screen.findByRole('radio', { name: /tüm yeni ilanlar/i }));
    await waitFor(() => expect(previewBodies.some((b) => (b as { minDiscountPct: number }).minDiscountPct === 0)).toBe(true), { timeout: 3000 });
    const last = previewBodies[previewBodies.length - 1] as Record<string, unknown>;
    expect(last).not.toHaveProperty('minConfidence');
    expect(previewInvalid).toEqual([]);
  });

  it('adım değişince canlı bölgede duyurur ve başlığa odaklanır', async () => {
    mockApi();
    const u = user();
    renderWithClient(<NewProfilePage />);
    await u.click(await screen.findByRole('button', { name: /^devam$/i }));
    expect(await screen.findByText('Adım 2/3: Fırsat ölçütü')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Fırsat ölçütü' })).toHaveFocus();
  });

  it('alan hatalarını canlı gösterir ve önizlemede aynı sebebi listeler', async () => {
    mockApi();
    const u = user();
    renderWithClient(<NewProfilePage />);
    const year = await screen.findByLabelText('En eski model yılı');
    await u.type(year, '1900');
    expect(await screen.findAllByText('Yıl 1950 ile 2100 arasında olmalı')).toHaveLength(2);
    expect(year).toHaveAttribute('aria-describedby', 'pf-year-min-err');
    expect(screen.getByText(/önizleme için işaretli alanları düzeltin/i)).toBeInTheDocument();
  });

  it('şehir taslağı alandan çıkınca eklenir', async () => {
    mockApi();
    server.use(
      http.post('*/api/v1/me/search-profiles', async ({ request }) => {
        postBodies.push(await request.json());
        return HttpResponse.json(profile(), { status: 201 });
      }),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await u.type(await screen.findByLabelText('Şehirler'), 'Ankara');
    await goStep(u, 3);
    await u.type(await screen.findByLabelText('Profil adı'), 'Şehirli');
    await u.click(screen.getByRole('button', { name: /profili oluştur/i }));
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({ cities: ['Ankara'] });
  });

  it('fiyat düşüşü kapalıyken geçersiz eşik kaydı engellemez ve gönderilmez', async () => {
    mockApi({ profiles: [profile()] });
    server.use(
      http.get('*/api/v1/me/search-profiles/p1', () => HttpResponse.json(profile())),
      http.patch('*/api/v1/me/search-profiles/p1', async ({ request }) => {
        patchBodies.push(await request.json());
        return HttpResponse.json(profile({ notifyOnPriceDrop: false }));
      }),
    );
    const u = user();
    renderWithClient(<EditProfilePage />);
    await goStep(u, 2);
    const pct = await screen.findByLabelText('Düşüş eşiği (%)');
    await u.clear(pct);
    expect(await screen.findByText('Düşüş eşiği %1 ile %50 arasında olmalı')).toBeInTheDocument();
    await u.click(screen.getByRole('switch', { name: /fiyat düşüşünde haber ver/i }));
    expect(screen.queryByText('Düşüş eşiği %1 ile %50 arasında olmalı')).not.toBeInTheDocument();
    await goStep(u, 2);
    await u.click(await screen.findByRole('button', { name: /değişiklikleri kaydet/i }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ notifyOnPriceDrop: false });
  });

  it('LIMIT_REACHED PLAN uyarısı yükseltme bağlantısı verir', async () => {
    mockApi();
    server.use(
      http.post('*/api/v1/me/search-profiles', () =>
        HttpResponse.json({ error: { code: 'LIMIT_REACHED', message: 'x', details: { limit: 3, reason: 'PLAN' } } }, { status: 403 }),
      ),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 3);
    await u.type(await screen.findByLabelText('Profil adı'), 'X');
    await u.click(screen.getByRole('button', { name: /profili oluştur/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/sınırına ulaştınız/i);
    expect(within(alert).getByRole('link', { name: /planları gör/i })).toHaveAttribute('href', '/app/abonelik');
    expect(screen.getByLabelText('Profil adı')).toHaveValue('X');
  });

  it('LIMIT_REACHED TELEGRAM kanal uyarısı gösterir', async () => {
    mockApi();
    server.use(
      http.post('*/api/v1/me/search-profiles', () =>
        HttpResponse.json({ error: { code: 'LIMIT_REACHED', message: 'x', details: { channel: 'TELEGRAM' } } }, { status: 403 }),
      ),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await goStep(u, 3);
    await u.type(await screen.findByLabelText('Profil adı'), 'X');
    const tg = await screen.findByRole('switch', { name: /telegram/i });
    await waitFor(() => expect(tg).toBeEnabled());
    await u.click(tg);
    await u.click(screen.getByRole('button', { name: /profili oluştur/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/telegram bildirimlerini içermiyor/i);
    expect(screen.getByRole('switch', { name: /telegram/i })).toBeChecked();
  });
});

describe('önizleme', () => {
  it('hata olunca mesaj gösterir', async () => {
    mockApi();
    server.use(
      http.post('*/api/v1/me/search-profiles/preview', () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'x' } }, { status: 500 })),
    );
    renderWithClient(<NewProfilePage />);
    expect(await screen.findByText(/bir sorun oluştu/i, undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('sırasız dönen yanıt son ölçütün sonucunu ezmez', async () => {
    mockApi();
    let n = 0;
    server.use(
      http.post('*/api/v1/me/search-profiles/preview', async () => {
        n++;
        if (n === 1) {
          await delay(1500);
          return HttpResponse.json({ estimatedDailyMatches: 1.1, items: [] });
        }
        return HttpResponse.json({ estimatedDailyMatches: 9.9, items: [] });
      }),
    );
    const u = user();
    renderWithClient(<NewProfilePage />);
    await u.type(await screen.findByLabelText('Azami km'), '5');
    expect(await screen.findByText('~9,9', undefined, { timeout: 3000 })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(screen.getByText('~9,9')).toBeInTheDocument();
    expect(screen.queryByText('~1,1')).not.toBeInTheDocument();
  }, 10000);
});

describe('wizard: düzenleme', () => {
  it('temizlenen alan için PATCH null gönderir', async () => {
    mockApi({ profiles: [profile()] });
    server.use(
      http.get('*/api/v1/me/search-profiles/p1', () => HttpResponse.json(profile())),
      http.patch('*/api/v1/me/search-profiles/p1', async ({ request }) => {
        patchBodies.push(await request.json());
        return HttpResponse.json(profile({ kmMax: null }));
      }),
    );
    const u = user();
    renderWithClient(<EditProfilePage />);
    await u.clear(await screen.findByLabelText('Azami km'));
    await goStep(u, 3);
    await u.click(await screen.findByRole('button', { name: /değişiklikleri kaydet/i }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ kmMax: null });
  });

  it('mod ve kanal değişimi yalnızca ilgili alanları gönderir', async () => {
    mockApi({ profiles: [profile()] });
    server.use(
      http.get('*/api/v1/me/search-profiles/p1', () => HttpResponse.json(profile())),
      http.patch('*/api/v1/me/search-profiles/p1', async ({ request }) => {
        patchBodies.push(await request.json());
        return HttpResponse.json(profile());
      }),
    );
    const u = user();
    renderWithClient(<EditProfilePage />);
    await goStep(u, 2);
    await u.click(await screen.findByRole('radio', { name: /tüm yeni ilanlar/i }));
    await goStep(u, 2);
    const tg = await screen.findByRole('switch', { name: /telegram/i });
    await waitFor(() => expect(tg).toBeEnabled());
    await u.click(tg);
    await u.click(screen.getByRole('button', { name: /değişiklikleri kaydet/i }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ minDiscountPct: 0, channels: ['IN_APP', 'TELEGRAM'] });
  });

  it('PATCH yalnızca değişen alanları gönderir', async () => {
    mockApi({ profiles: [profile()] });
    server.use(
      http.get('*/api/v1/me/search-profiles/p1', () => HttpResponse.json(profile())),
      http.patch('*/api/v1/me/search-profiles/p1', async ({ request }) => {
        patchBodies.push(await request.json());
        return HttpResponse.json(profile({ name: 'Yeni ad' }));
      }),
    );
    const u = user();
    renderWithClient(<EditProfilePage />);
    await goStep(u, 3);
    const name = await screen.findByLabelText('Profil adı');
    expect(name).toHaveValue('BMW fırsatları');
    await u.clear(name);
    await u.type(name, 'Yeni ad');
    await u.click(screen.getByRole('button', { name: /değişiklikleri kaydet/i }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ name: 'Yeni ad' });
  });
});

describe('profil listesi', () => {
  it('duraklatır', async () => {
    mockApi({ profiles: [profile()] });
    const calls: string[] = [];
    server.use(
      http.post('*/api/v1/me/search-profiles/p1/pause', () => {
        calls.push('pause');
        return HttpResponse.json(profile({ status: 'PAUSED' }));
      }),
      http.post('*/api/v1/me/search-profiles/p1/resume', () => {
        calls.push('resume');
        return HttpResponse.json(
          { error: { code: 'LIMIT_REACHED', message: 'x', details: { limit: 3, reason: 'PLAN' } } },
          { status: 403 },
        );
      }),
    );
    const u = user();
    renderWithClient(<ProfilesPage />);
    const sw = await screen.findByRole('switch', { name: /bmw fırsatları durumu/i });
    expect(sw).toBeChecked();
    await u.click(sw);
    await waitFor(() => expect(calls).toEqual(['pause']));
  });

  it('sürdürme LIMIT_REACHED mesajı', async () => {
    mockApi({ profiles: [profile({ status: 'PAUSED' })] });
    server.use(
      http.post('*/api/v1/me/search-profiles/p1/resume', () =>
        HttpResponse.json({ error: { code: 'LIMIT_REACHED', message: 'x', details: { limit: 3, reason: 'PLAN' } } }, { status: 403 }),
      ),
    );
    const u = user();
    renderWithClient(<ProfilesPage />);
    await u.click(await screen.findByRole('switch', { name: /bmw fırsatları durumu/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/sınırına ulaştınız/i);
    expect(screen.getByRole('switch', { name: /bmw fırsatları durumu/i })).not.toBeChecked();
  });

  it('limit doluyken yeni profil devre dışı, doğrulanmamışsa e-posta açıklaması', async () => {
    mockApi({ verified: false, max: 3, profiles: [profile()] });
    renderWithClient(<ProfilesPage />);
    expect(await screen.findByText('1/1 profil')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /yeni profil/i })).toBeDisabled();
    expect(screen.getByText(/e-postanızı doğrulayın/i)).toBeInTheDocument();
  });

  it('plan limiti doluyken yükseltme bağlantısı gösterir', async () => {
    mockApi({ max: 1, profiles: [profile()] });
    renderWithClient(<ProfilesPage />);
    expect(await screen.findByText('1/1 profil')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /planı yükseltin/i })).toHaveAttribute('href', '/app/abonelik');
  });

  it('eşleşmeleri gör bağlantısı profil filtreli', async () => {
    mockApi({ profiles: [profile()] });
    renderWithClient(<ProfilesPage />);
    expect(await screen.findByRole('link', { name: /eşleşmeleri gör/i })).toHaveAttribute('href', '/app/eslesmeler?profileId=p1');
  });

  it('silmeden önce onay ister', async () => {
    mockApi({ profiles: [profile()] });
    let deleted = 0;
    server.use(
      http.delete('*/api/v1/me/search-profiles/p1', () => {
        deleted++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const u = user();
    renderWithClient(<ProfilesPage />);
    await u.click(await screen.findByRole('button', { name: /bmw fırsatları profilini sil/i }));
    expect(deleted).toBe(0);
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: /^sil$/i }));
    await waitFor(() => expect(deleted).toBe(1));
  });
});
