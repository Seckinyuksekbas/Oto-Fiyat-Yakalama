import { expect, test, type Page } from '@playwright/test';
import { CLUSTERS, dealFor } from '../support/clusters';
import { attachDiagnostics } from '../support/diagnostics';
import { closeDb, db, demoSource } from '../support/db';
import { demo, telegram } from '../support/demo';
import { adminCredentials } from '../support/env';
import { createLinkedUser, loginViaUi } from '../support/session';

// Playwright ilk parametrede fixture nesnesi kalıbı ister.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => attachDiagnostics(testInfo));

test.afterAll(async () => {
  // Senaryo yarıda kalsa bile demo-site normal moda döner (sonraki senaryolar taramaya güvenir).
  await demo.mode('normal').catch(() => undefined);
  // Senaryo engel adımında düşerse kaynak PAUSED kalır ve sonraki senaryolar hiç tarama görmez: yalıtım için onarılır.
  await db()
    .dataSource.updateMany({ where: { code: 'demo-site', health: 'PAUSED' }, data: { health: 'HEALTHY', isActive: true, consecutiveFailures: 0 } })
    .catch(() => undefined);
  await closeDb();
});

async function loginAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await loginViaUi(page, email, password);
}

test('admin: dry-run, yeniden analiz, FAILED bildirim + yeniden dene, ayarlar, engel alarmı', async ({ page }) => {
  await loginAdmin(page);
  const source = await demoSource();

  await test.step('kaynak detayında dry-run: sonuç tablosu ≥ 1 ilan', async () => {
    await page.goto(`/admin/kaynaklar/${source.id}`);
    await expect(page.getByRole('heading', { level: 1, name: source.name })).toBeVisible();
    const start = page.getByRole('button', { name: 'Test taraması başlat' });
    const preview = page.getByRole('table', { name: /Dry-run önizlemesi: normalize edilen ilk \d+ ilan/ });
    const busy = page.getByText('Bu kaynak için devam eden bir iş var');
    // Kaynak 10 sn'de bir zamanlanmış olarak taranır; o an bir iş sıradaysa API 409 verir (ve throttle anahtarını
    // bırakır). Boş bir anı bekleyip yeniden denenir.
    await expect(async () => {
      await expect
        .poll(() => db().collectionJob.count({ where: { sourceId: source.id, status: { in: ['QUEUED', 'RUNNING'] } } }), { timeout: 15_000, intervals: [200] })
        .toBe(0);
      await start.click();
      await expect(preview.or(busy)).toBeVisible({ timeout: 60_000 });
      await expect(busy).toBeHidden({ timeout: 100 });
    }).toPass({ timeout: 120_000, intervals: [500, 1000] });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);
  });

  await test.step('bir ilanı yeniden analiz ettir: yeni analiz bildirimi', async () => {
    const listing = await db().listing.findFirstOrThrow({
      where: { sourceId: source.id, make: CLUSTERS.admin.make, model: CLUSTERS.admin.model, status: 'ACTIVE', latestAnalysisId: { not: null } },
      orderBy: { id: 'desc' },
    });
    await page.goto(`/admin/ilanlar/${listing.id}`);
    await page.getByRole('button', { name: 'Yeniden analiz et' }).click();
    await expect(page.getByText('Yeni analiz hazır; değerler güncellendi.')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Yeniden analiz tamamlandı' })).toBeVisible();
  });

  await test.step('Telegram 403 (blocked) → bildirim FAILED; admin "yeniden dene" özeti', async () => {
    const victim = await createLinkedUser('blocked', CLUSTERS.admin);
    for (const method of ['sendMessage', 'sendPhoto']) {
      await telegram.fail({ method, chatId: victim.chatId, status: 403, description: 'Forbidden: bot was blocked by the user' });
    }
    await demo.inject(dealFor('admin'));

    let failedId = 0;
    await expect
      .poll(
        async () => {
          const n = await db().notification.findFirst({ where: { userId: victim.id, channel: 'TELEGRAM', status: 'FAILED' }, orderBy: { id: 'desc' } });
          failedId = n?.id ?? 0;
          return failedId;
        },
        { message: 'FAILED Telegram bildirimi', timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    await page.goto('/admin/bildirimler');
    await page.getByLabel('Durum').selectOption({ label: 'Başarısız' });
    // Kullanıcı süzgeci 300 ms gecikmeli uygulanır ve yeni sorgu seçimi sıfırlar: süzülmüş yanıt gelmeden seçim yapılmaz.
    const filtered = page.waitForResponse((r) => r.url().includes('/api/v1/admin/notifications?') && r.url().includes(`userId=${victim.id}`) && r.url().includes('status=FAILED'));
    await page.getByLabel('Kullanıcı kimliği').fill(victim.id);
    expect((await filtered).ok()).toBe(true);
    const table = page.getByRole('region', { name: 'Bildirimler' });
    const row = table.getByRole('row').filter({ hasText: `#${failedId}` });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Başarısız');
    await page.getByRole('checkbox', { name: `Bildirim #${failedId} seç` }).check();
    await page.getByRole('button', { name: 'Seçilenleri yeniden dene (1)' }).click();
    const summary = page.getByRole('status', { name: 'Yeniden deneme sonucu' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/bildirim yeniden kuyruğa alındı|bildirim atlandı/);
    await victim.api.dispose();
  });

  await test.step("Ayarlar'da minComparables değiştir → kaydet → başarı", async () => {
    await page.goto('/admin/ayarlar');
    const field = page.getByRole('textbox', { name: 'En az emsal', exact: true });
    await expect(field).toBeVisible();
    const before = await field.inputValue();
    const next = before === '6' ? '7' : '6';
    await field.fill(next);
    await page.getByRole('button', { name: 'Analiz katsayılarını kaydet' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Analiz katsayıları kaydedildi' })).toBeVisible();
    await expect(field).toHaveValue(next);
  });

  await test.step('demo-site captcha → kaynak duraklatılır, genel bakışta 60 sn içinde alarm', async () => {
    await demo.mode('captcha');
    await page.goto('/admin');
    const alerts = page.getByRole('region', { name: 'Son alarmlar' });
    await expect(alerts.getByText(/erişimimizi engelledi; kaynak duraklatıldı/)).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await demoSource()).health, { message: 'kaynak sağlığı' }).toBe('PAUSED');
  });

  await test.step('demo-site normale, kaynak etkinleştirilir ve yeniden taranır', async () => {
    await demo.mode('normal');
    const resumedAt = new Date();
    await page.goto(`/admin/kaynaklar/${source.id}`);
    // Rozet: "Duraklatıldı" ya da "Engel nedeniyle duraklatıldı".
    await expect(page.getByText(/duraklatıldı$/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Etkinleştir' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Kaynak etkinleştirildi' })).toBeVisible();
    await expect
      .poll(
        async () =>
          db().collectionJob.count({ where: { sourceId: source.id, dryRun: false, status: 'SUCCEEDED', finishedAt: { gt: resumedAt } } }),
        { message: 'etkinleştirme sonrası başarılı tarama', timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    expect((await demoSource()).health).not.toBe('PAUSED');
  });
});
