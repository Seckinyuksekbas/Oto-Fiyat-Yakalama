import { expect, test, type Browser, type Page } from '@playwright/test';
import { CLUSTERS } from '../support/clusters';
import { closeDb, db } from '../support/db';
import { adminCredentials } from '../support/env';
import { createVerifiedUser, loginViaUi } from '../support/session';

/**
 * Nonce tabanlı CSP (web middleware): kullanıcı ve admin olarak sayfalar gezilir. Her sayfada:
 *  - `securitypolicyviolation` olayı 0,
 *  - `content-security-policy` başlığı var; `script-src` `'nonce-` içerir, `'unsafe-inline'` içermez,
 *  - CSP kaynaklı konsol mesajı ve `pageerror` 0 (/api'nin beklenen 4xx yanıtları sayılmaz).
 * İlan sayfasında en az bir ilan görseli (`<img>`) gerçekten yüklenmiş olmalı (naturalWidth > 0).
 */
declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test.afterAll(closeDb);

const CSP_CONSOLE = /content security policy|content-security-policy|refused to (load|execute|apply|connect|frame)/i;

interface Seen {
  problems: string[];
}

async function openWatched(browser: Browser): Promise<{ page: Page; seen: Seen; close: () => Promise<void> }> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations!.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const page = await context.newPage();
  const seen: Seen = { problems: [] };
  page.on('console', (m) => {
    if (CSP_CONSOLE.test(m.text())) seen.problems.push(`${page.url()}: console.${m.type()} ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => seen.problems.push(`${page.url()}: pageerror ${String(e).slice(0, 300)}`));
  return { page, seen, close: () => context.close() };
}

function scriptSrc(csp: string): string {
  return (
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src ')) ?? ''
  );
}

async function visitAndCheck(page: Page, seen: Seen, path: string): Promise<void> {
  await test.step(path, async () => {
    const before = seen.problems.length;
    const res = await page.goto(path);
    expect(res, `${path} yanıtı`).not.toBeNull();
    const csp = res!.headers()['content-security-policy'];
    expect(csp, `${path} content-security-policy başlığı`).toBeTruthy();
    const scripts = scriptSrc(csp!);
    expect(scripts, `${path} script-src`).toContain("'nonce-");
    expect(scripts, `${path} script-src`).not.toContain("'unsafe-inline'");
    // Uygulama hidrasyonu: sayfa başlığı (h1) ve kabuk etkileşimli.
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeAttached();
    await expect(page.locator('body')).not.toBeEmpty();
    expect(await page.evaluate(() => window.__cspViolations ?? []), `${path} securitypolicyviolation`).toEqual([]);
    expect(seen.problems.slice(before), `${path} CSP konsol mesajları / pageerror`).toEqual([]);
  });
}

function userListing() {
  return db().listing.findFirstOrThrow({
    where: { make: CLUSTERS.user.make, model: CLUSTERS.user.model, status: 'ACTIVE', latestAnalysisId: { not: null }, imageUrl: { not: null } },
    orderBy: { id: 'desc' },
  });
}

test('CSP: kullanıcı ve admin sayfaları nonce CSP ile ihlalsiz', async ({ browser }) => {
  const listing = await userListing();

  await test.step('kullanıcı', async () => {
    const user = await createVerifiedUser('csp');
    await user.api.dispose();
    const { page, seen, close } = await openWatched(browser);
    await loginViaUi(page, user.email, user.password);
    for (const path of ['/app', '/app/firsatlar', '/app/eslesmeler', `/app/ilan/${listing.id}`]) await visitAndCheck(page, seen, path);
    await close();
  });

  await test.step('admin', async () => {
    const { email, password } = adminCredentials();
    const { page, seen, close } = await openWatched(browser);
    await loginViaUi(page, email, password);
    for (const path of ['/admin', '/admin/kaynaklar']) await visitAndCheck(page, seen, path);
    await close();
  });
});

test('CSP: ilan sayfasında ilan görseli yüklenir (img-src + CSP_IMG_EXTRA)', async ({ browser }) => {
  const listing = await userListing();
  const user = await createVerifiedUser('cspimg');
  await user.api.dispose();
  const { page, seen, close } = await openWatched(browser);
  await loginViaUi(page, user.email, user.password);
  await visitAndCheck(page, seen, `/app/ilan/${listing.id}`);
  // Uygulama görsel hata verirse <img>'i kaldırır; bu yüzden "yüklenmiş" = başka origin'den naturalWidth > 0 olan bir <img>.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images)
            .filter((img) => !img.src.startsWith(location.origin))
            .some((img) => img.complete && img.naturalWidth > 0),
        ),
      { message: `ilan görseli yüklendi (${listing.imageUrl})`, timeout: 15_000 },
    )
    .toBe(true);
  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
  await close();
});
