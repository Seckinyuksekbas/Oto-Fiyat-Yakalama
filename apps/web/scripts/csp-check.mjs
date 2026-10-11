// CSP duman testi: çalışan prod derlemesine (next start / standalone) karşı sayfaları gezer,
// `securitypolicyviolation` olaylarını ve konsol hatalarını sayar; herhangi biri varsa çıkış kodu 1.
// Kullanım: WEB_URL=http://localhost:3100 node apps/web/scripts/csp-check.mjs
//   API erişilebilirse (WEB_URL/api/v1/health/live 2xx) kimlik doğrulamalı sayfalar da gezilir:
//   geçici bir kullanıcı kaydolur ve oturum açılır (e-posta doğrulaması gerekmeyen sayfalar).
//   Yalnız genel sayfalar için CSP_PUBLIC_ONLY=1. Kalıcı E2E karşılığı: apps/e2e/tests/csp.spec.ts (Task 11).
/* global window, document -- page.evaluate / addInitScript gövdeleri tarayıcıda çalışır */
import { chromium } from '@playwright/test';

const WEB = (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const PUBLIC_PAGES = ['/', '/giris', '/kayit', '/sifremi-unuttum', '/kvkk'];
const AUTH_PAGES = ['/app', '/app/firsatlar', '/app/profiller', '/app/ayarlar', '/app/bildirimler'];

async function apiReachable() {
  if (process.env.CSP_PUBLIC_ONLY === '1') return false;
  try {
    const res = await fetch(`${WEB}/api/v1/health/live`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} blocked=${e.blockedURI || 'inline'} sample=${(e.sample || '').slice(0, 60)}`);
  });
});

const results = [];
let total = 0;
const apiUp = await apiReachable();

async function visit(page, path) {
  const consoleErrors = [];
  const ignored = [];
  const onConsole = (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url ?? '';
    const text = `${msg.text().slice(0, 200)}${url ? ` (${url})` : ''}`;
    // API kapalıyken /api rewrite'ı 500 döner: CSP ile ilgisiz, ayrı raporlanır.
    if (!apiUp && url.startsWith(`${WEB}/api/`)) ignored.push(text);
    else consoleErrors.push(text);
  };
  const onPageError = (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  const res = await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  const csp = res?.headers()['content-security-policy'] ?? '(yok)';
  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  const hydrated = await page.evaluate(() => typeof window.next !== 'undefined' || !!document.querySelector('[data-hydrated]'));
  results.push({ path: `${path} -> ${new URL(page.url()).pathname}`, status: res?.status(), violations, consoleErrors, ignored, hydrated });
  total += violations.length + consoleErrors.length;
  return csp;
}

const page = await context.newPage();
let firstCsp;
for (const p of PUBLIC_PAGES) {
  const csp = await visit(page, p);
  firstCsp ??= csp;
}

if (apiUp) {
  const email = `csp-${Date.now()}@example.com`;
  const password = `Csp-${Math.random().toString(36).slice(2)}-Aa1`;
  const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: WEB, 'Content-Type': 'application/json' };
  const reg = await context.request.post(`${WEB}/api/v1/auth/register`, {
    headers,
    data: { email, password, name: 'CSP Denetimi', kvkkAccepted: true },
  });
  const login = await context.request.post(`${WEB}/api/v1/auth/login`, { headers, data: { email, password } });
  if (login.ok()) {
    for (const p of AUTH_PAGES) await visit(page, p);
  } else {
    console.log(`(kimlik doğrulamalı sayfalar atlandı: register ${reg.status()}, login ${login.status()})`);
  }
} else {
  console.log('(API erişilemiyor: yalnız genel sayfalar gezildi)');
}

await browser.close();

console.log(`CSP: ${firstCsp}`);
for (const r of results) {
  const n = r.violations.length + r.consoleErrors.length;
  console.log(`${n === 0 ? 'OK  ' : 'FAIL'} ${r.path} [${r.status}] hydrated=${r.hydrated} violations=${r.violations.length} consoleErrors=${r.consoleErrors.length}`);
  for (const v of r.violations) console.log(`     violation: ${v}`);
  for (const c of r.consoleErrors) console.log(`     console: ${c}`);
  for (const c of r.ignored) console.log(`     yok sayıldı (API kapalı): ${c}`);
}
console.log(`Toplam: ${total}`);
process.exit(total === 0 ? 0 : 1);
