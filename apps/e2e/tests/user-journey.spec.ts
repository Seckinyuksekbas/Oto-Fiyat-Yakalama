import { expect, test } from '@playwright/test';
import { dealFor } from '../support/clusters';
import { attachDiagnostics } from '../support/diagnostics';
import { closeDb, db, demoSource, listingByExternalId } from '../support/db';
import { demo, randomChatId, telegram, type TgMessage } from '../support/demo';
import { adminCredentials, WEB_ORIGIN } from '../support/env';
import { loginViaUi, randomUser, waitForVerifyLink } from '../support/session';

// Playwright ilk parametrede fixture nesnesi kalıbı ister.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => attachDiagnostics(testInfo));

test.afterAll(closeDb);

test('kullanıcı: kayıt → doğrulama → Telegram → profil → canlı fırsat bildirimi → admin görünümü', async ({ page, browser }) => {
  const user = randomUser('user');
  const chatId = randomChatId();

  await test.step('kayıt ol', async () => {
    await page.goto('/kayit');
    await expect(page.getByRole('heading', { level: 1, name: 'Hesap oluşturun' })).toBeVisible();
    await page.getByLabel('Ad').fill(user.name);
    await page.getByLabel('E-posta').fill(user.email);
    await page.getByLabel('Şifre').fill(user.password);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Hesap oluştur' }).click();
    await expect(page).toHaveURL(/\/app(\/|$|\?)/);
  });

  await test.step("Mailpit'teki bağlantıyla e-postayı doğrula", async () => {
    const link = await waitForVerifyLink(user.email);
    expect(new URL(link).origin).toBe(WEB_ORIGIN);
    await page.goto(link);
    await expect(page.getByText('E-posta adresiniz doğrulandı. Artık tüm özellikleri kullanabilirsiniz.')).toBeVisible();
  });

  await test.step("Ayarlar'da Telegram'ı bağla (deep-link kodu → sahte Telegram /start, polling)", async () => {
    await page.goto('/app/ayarlar/kanallar');
    await page.getByRole('button', { name: "Telegram'ı bağla" }).click();
    const deepLink = await page.getByRole('link', { name: "Telegram'ı aç" }).getAttribute('href');
    expect(deepLink).toMatch(/^https:\/\/t\.me\/oto_e2e_bot\?start=/);
    const code = new URL(deepLink!).searchParams.get('start')!;
    await telegram.pushStart(chatId, code);
    await expect(page.getByText('Bağlandı', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await telegram.messages(chatId)).some((m) => m.text.includes('hesabı bağlandı')), { message: 'bot onay yanıtı' })
      .toBe(true);
  });

  const deal = dealFor('user');
  await test.step(`profil oluştur: ${deal.make} ${deal.model}, en az %10 indirim, Telegram`, async () => {
    await page.goto('/app/profiller/yeni');
    await page.locator('#pf-make').click();
    await page.getByRole('option', { name: deal.make, exact: true }).click();
    await page.locator('#pf-model').click();
    await page.getByRole('option', { name: deal.model, exact: true }).click();
    await page.getByRole('button', { name: 'Devam' }).click();

    const slider = page.locator('#pf-discount');
    await slider.focus();
    for (let i = 0; i < 5; i++) await slider.press('ArrowLeft'); // varsayılan %15 → %10
    await expect(slider).toHaveAttribute('aria-valuetext', 'yüzde 10');
    await page.getByRole('radiogroup', { name: 'Minimum güven' }).getByText('Düşük', { exact: true }).click();
    await page.getByRole('button', { name: 'Devam' }).click();

    const tg = page.locator('#pf-ch-tg');
    await expect(tg).toBeEnabled();
    await tg.click();
    await expect(tg).toHaveAttribute('aria-checked', 'true');
    // Yüklü makinede kayıt (limit kilidi tx'i) yavaş olabilir: yanıt beklenir ve durumu hata mesajında görünür.
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/search-profiles') && r.request().method() === 'POST', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Profili oluştur' }).click();
    const res = await created;
    expect(res.status(), `POST /me/search-profiles: ${await res.text().catch(() => '')}`).toBe(201);
    await expect(page).toHaveURL(/\/app\/profiller$/);
    await expect(page.getByRole('heading', { level: 2, name: `${deal.make} ${deal.model}` })).toBeVisible();
  });

  await test.step('okunmamışları sıfırla ve panoda bekle', async () => {
    // Telegram bağlama bir SECURITY bildirimi üretir; sayaç eşleşme için 1'den başlamalı.
    await page.goto('/app/bildirimler');
    // "Hepsini okudunuz" iyimser güncellemedir; sunucu onayı beklenmeden gezinilirse pano eski sayacı okur.
    const marked = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/notifications/read') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Tümünü okundu yap' }).click();
    expect((await marked).ok()).toBe(true);
    await expect(page.getByText('Hepsini okudunuz')).toBeVisible();
    await page.goto('/app');
    await expect(page.getByRole('button', { name: 'Bildirimler', exact: true })).toBeVisible();
  });

  const injected = await demo.inject(deal);
  const title = `${deal.make} ${deal.model} ${deal.trim} · ${deal.year}`;

  await test.step('60 sn içinde: canlı toast, zil sayacı 1', async () => {
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Yeni eşleşme' }).filter({ hasText: `${deal.make} ${deal.model}` });
    await expect(toast).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Bildirimler, 1 okunmamış' })).toBeVisible();
    await expect(page.getByTestId('bell-count')).toHaveText('1');
  });

  await test.step('bildirim listesinde ilan görünür', async () => {
    await page.goto('/app/bildirimler');
    // Aynı eşleşme için IN_APP ve TELEGRAM olmak üzere iki satır listelenir.
    const rows = page.getByRole('link', { name: new RegExp(escapeRe(title)) });
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: 'Telegram' }).first()).toBeVisible();
  });

  let analysisUrl = '';
  await test.step('sahte Telegram ilan başlıklı mesajı aldı; "Analizi gör" /ilan/:id açar', async () => {
    let msg: TgMessage | undefined;
    await expect
      .poll(
        async () => {
          msg = (await telegram.messages(chatId)).find((m) => m.text.includes(`${deal.make} ${deal.model}`));
          return msg?.text ?? null;
        },
        { message: 'Telegram fırsat mesajı', timeout: 60_000 },
      )
      .toContain(`${deal.make} ${deal.model} ${deal.trim} · ${deal.year}`);
    const button = msg!.replyMarkup?.inline_keyboard?.flat().find((b) => b.text === 'Analizi gör');
    expect(button?.url, '"Analizi gör" düğmesi').toBeTruthy();
    analysisUrl = button!.url!;
    const listing = await listingByExternalId(injected.id);
    expect(analysisUrl).toBe(`${WEB_ORIGIN}/ilan/${listing!.id}`);

    await page.goto(analysisUrl);
    await expect(page).toHaveURL(new RegExp(`/app/ilan/${listing!.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  });

  await test.step('seed admin: işler listesinde tarama işi, bildirimlerde SENT', async () => {
    const listing = await listingByExternalId(injected.id);
    const source = await demoSource();
    const job = await db().collectionJob.findFirst({
      where: { sourceId: source.id, dryRun: false, status: { in: ['SUCCEEDED', 'PARTIAL'] }, startedAt: { lte: listing!.firstSeenAt }, listingsNew: { gt: 0 } },
      orderBy: { id: 'desc' },
    });
    expect(job, 'ilanı ilk gören tarama işi').toBeTruthy();
    const dbUser = await db().user.findUniqueOrThrow({ where: { email: user.email } });

    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    const { email, password } = adminCredentials();
    await loginViaUi(admin, email, password);

    await admin.goto(`/admin/isler?kaynak=${source.id}`);
    await admin.getByLabel('Durum').selectOption({ label: job!.status === 'PARTIAL' ? 'Kısmi' : 'Başarılı' });
    const jobs = admin.getByRole('region', { name: 'Toplama işleri' });
    await expect(jobs.getByRole('link', { name: `İş #${job!.id}`, exact: true })).toBeVisible();

    await admin.goto('/admin/bildirimler');
    await admin.getByLabel('Durum').selectOption({ label: 'Gönderildi' });
    await admin.getByLabel('Kanal').selectOption({ label: 'Telegram' });
    await admin.getByLabel('Kullanıcı kimliği').fill(dbUser.id);
    const table = admin.getByRole('region', { name: 'Bildirimler' });
    const row = table.getByRole('row').filter({ hasText: user.email }).filter({ hasText: 'Gönderildi' });
    await expect(row.first()).toBeVisible();
    await ctx.close();
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
