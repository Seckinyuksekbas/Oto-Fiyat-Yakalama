// Görsel smoke: çalışan yığına (web :3000 -> api :3001) karşı kullanıcı ve admin sayfalarının ekran görüntülerini alır.
// Kullanım: node apps/web/scripts/screenshots.mjs
//   WEB_URL, PG_CONTAINER; admin sayfaları için seed süper admin: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
//   (yoksa .env.example varsayılanları). SKIP_ADMIN=1 admin sayfalarını atlar.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const PG = process.env.PG_CONTAINER ?? 'oto-scraper-postgres-1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.screenshots');
const stamp = Date.now();
const email = `smoke-${stamp}@example.com`;
// Tek kullanımlık smoke kullanıcısı: parola çalışma anında üretilir (repoda sabit parola yok).
const password = 'Smoke-' + randomBytes(12).toString('base64url');
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-please-123';
const withAdmin = process.env.SKIP_ADMIN !== '1';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '1440-dark', width: 1440, height: 900, theme: 'dark' },
  { name: '1440-light', width: 1440, height: 900, theme: 'light' },
  { name: '390-dark', width: 390, height: 844, theme: 'dark' },
];

const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: WEB, 'Content-Type': 'application/json' };

async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${WEB}/api/v1${path}`, { method, headers, data });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text}`);
  return text ? JSON.parse(text) : null;
}

const browser = await chromium.launch();
const setup = await browser.newContext();
await api(setup, 'POST', '/auth/register', { email, password, name: 'Smoke Kullanıcı', kvkkAccepted: true });
execFileSync('docker', ['exec', PG, 'psql', '-U', 'oto', '-d', 'oto', '-c', `UPDATE "User" SET "emailVerifiedAt" = now() WHERE email = '${email}'`], { stdio: 'inherit' });
await api(setup, 'POST', '/auth/login', { email, password });
await api(setup, 'POST', '/me/search-profiles', {
  name: 'Smoke profili',
  minDiscountPct: 0.1,
  minConfidence: 'LOW',
  channels: ['IN_APP'],
});
const state = await setup.storageState();
// Eşleşmelerin / fırsatların oluşması için kısa bekleme (profil önceden analizli ilanları da gösterir).
let opp = null;
for (let i = 0; i < 20 && !opp; i++) {
  const r = await api(setup, 'GET', '/me/opportunities?limit=5');
  opp = r?.items?.[0] ?? null;
  if (!opp) await new Promise((r2) => setTimeout(r2, 1500));
}
const oppId = opp?.id ?? null;
console.log('fırsat id:', oppId);
await setup.close();

// Admin oturumu (seed SUPER_ADMIN) ve detay sayfaları için örnek kimlikler.
let adminState = null;
const adminIds = {};
if (withAdmin) {
  const adminCtx = await browser.newContext();
  await api(adminCtx, 'POST', '/auth/login', { email: adminEmail, password: adminPassword });
  const first = async (path) => (await api(adminCtx, 'GET', path))?.items?.[0]?.id ?? null;
  adminIds.user = await first(`/admin/users?q=${encodeURIComponent(email)}`);
  adminIds.listing = oppId ?? (await first('/admin/listings?pageSize=1'));
  adminIds.source = await first('/admin/sources?pageSize=1');
  adminIds.job = await first('/admin/jobs?pageSize=1');
  console.log('admin örnek kimlikleri:', JSON.stringify(adminIds));
  adminState = await adminCtx.storageState();
  await adminCtx.close();
}

const ADMIN_PAGES = withAdmin
  ? [
      ['admin', '/admin'],
      ['admin-kullanicilar', '/admin/kullanicilar'],
      ...(adminIds.user ? [['admin-kullanici', `/admin/kullanicilar/${adminIds.user}`]] : []),
      ['admin-ilanlar', '/admin/ilanlar'],
      ...(adminIds.listing ? [['admin-ilan', `/admin/ilanlar/${adminIds.listing}`]] : []),
      ['admin-analizler', '/admin/analizler'],
      ['admin-kaynaklar', '/admin/kaynaklar'],
      ...(adminIds.source ? [['admin-kaynak', `/admin/kaynaklar/${adminIds.source}`]] : []),
      ['admin-isler', '/admin/isler'],
      ...(adminIds.job ? [['admin-is', `/admin/isler/${adminIds.job}`]] : []),
      ['admin-proxyler', '/admin/proxyler'],
      ['admin-sistem', '/admin/sistem'],
      ['admin-bildirimler', '/admin/bildirimler'],
      ['admin-paketler', '/admin/paketler'],
      ['admin-ayarlar', '/admin/ayarlar'],
      ['admin-denetim', '/admin/denetim'],
      ['admin-loglar', '/admin/loglar'],
    ].map(([name, path]) => [name, path, 'admin'])
  : [];

const PAGES = [
  ['home', '/', false],
  ['giris', '/giris', false],
  ['app', '/app', true],
  ['firsatlar', '/app/firsatlar', true],
  ...(oppId ? [['ilan', `/app/ilan/${oppId}`, true]] : []),
  ['profil-yeni', '/app/profiller/yeni', true],
  ['bildirimler', '/app/bildirimler', true],
  ['kanallar', '/app/ayarlar/kanallar', true],
  ['favoriler', '/app/favoriler', true],
  ['abonelik', '/app/abonelik', true],
  ...ADMIN_PAGES,
];

const report = { email, oppId, adminIds, pages: [] };
for (const vp of VIEWPORTS) {
  for (const [name, path, authed] of PAGES) {
    // /giris oturumluyken /app'e yönlenebilir; bu yüzden çıkış yapmış bağlamla alınır.
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      storageState: authed === 'admin' ? adminState : authed ? state : undefined,
      colorScheme: vp.theme,
    });
    await ctx.addInitScript(`try { window.localStorage.setItem('theme', '${vp.theme}'); } catch (e) { void e; }`);
    const page = await ctx.newPage();
    const entry = { page: name, path, viewport: vp.name, console: [], network: [], pageErrors: [] };
    page.on('console', (m) => {
      if (m.type() === 'error') entry.console.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => entry.pageErrors.push(String(e).slice(0, 300)));
    page.on('response', (r) => {
      if (r.status() >= 400) entry.network.push(`${r.status()} ${r.request().method()} ${r.url().replace(WEB, '')}`);
    });
    try {
      await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(800);
      entry.finalUrl = page.url().replace(WEB, '');
      const file = `${name}.${vp.name}.png`;
      await page.screenshot({ path: join(OUT, file), fullPage: true });
      entry.file = file;
    } catch (e) {
      entry.error = String(e).slice(0, 300);
    }
    report.pages.push(entry);
    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const bad = report.pages.filter((p) => p.console.length || p.network.length || p.pageErrors.length || p.error);
console.log(`${report.pages.length} ekran görüntüsü, ${bad.length} sayfada sorun`);
for (const p of bad) console.log(p.viewport, p.page, JSON.stringify({ c: p.console, n: p.network, e: p.pageErrors, err: p.error }));
