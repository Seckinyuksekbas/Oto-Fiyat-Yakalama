// CSP duman testi: çalışan prod derlemesine (next start / standalone) karşı sayfaları gezer,
// sayar: CSP başlığı eksik/zayıf (nonce yok, 'unsafe-inline' var), `securitypolicyviolation` olayları,
// CSP konsol mesajları ("Content Security Policy" / "Refused to") ve pageerror. Herhangi biri varsa çıkış kodu 1.
// Diğer konsol hataları yalnız bilgi olarak yazılır; beklenen /api 4xx'leri yok sayılır.
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

const CSP_CONSOLE = /Content Security Policy|Refused to/i;

/** Belge yanıtının CSP'si: yoksa, script-src'de nonce yoksa ya da 'unsafe-inline' varsa sorun listesi döner. */
function policyProblems(csp) {
  if (!csp) return ['content-security-policy başlığı yok'];
  const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) ?? '';
  const problems = [];
  if (!scriptSrc) problems.push('script-src yok');
  if (!scriptSrc.includes("'nonce-")) problems.push("script-src'de 'nonce-' yok");
  if (scriptSrc.includes("'unsafe-inline'")) problems.push("script-src'de 'unsafe-inline' var");
  return problems;
}

async function visit(page, path) {
  const cspConsole = [];
  const info = [];
  const onConsole = (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url ?? '';
    const text = `${msg.text().slice(0, 200)}${url ? ` (${url})` : ''}`;
    if (CSP_CONSOLE.test(msg.text())) cspConsole.push(text);
    // CSP dışı konsol hataları sayılmaz; beklenen /api 4xx'leri (ör. oturumsuz /me 401) hiç yazılmaz.
    else if (!(url.startsWith(`${WEB}/api/`) && / 4\d\d /.test(msg.text()))) info.push(text);
  };
  const onPageError = (err) => cspConsole.push(`pageerror: ${String(err).slice(0, 200)}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  const res = await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const violations = await page.evaluate(() => window.__cspViolations ?? []);
  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  // Yönlendirme zincirinin son belge yanıtı (ör. /app -> /giris).
  const csp = res?.headers()['content-security-policy'];
  const policy = policyProblems(csp);
  results.push({ path: `${path} -> ${new URL(page.url()).pathname}`, status: res?.status(), violations, cspConsole, policy, info });
  total += violations.length + cspConsole.length + policy.length;
  return csp ?? '(yok)';
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
  const n = r.violations.length + r.cspConsole.length + r.policy.length;
  console.log(
    `${n === 0 ? 'OK  ' : 'FAIL'} ${r.path} [${r.status}] policy=${r.policy.length} violations=${r.violations.length} cspConsole=${r.cspConsole.length}`,
  );
  for (const p of r.policy) console.log(`     policy: ${p}`);
  for (const v of r.violations) console.log(`     violation: ${v}`);
  for (const c of r.cspConsole) console.log(`     console: ${c}`);
  for (const c of r.info) console.log(`     bilgi (sayılmaz): ${c}`);
}
console.log(`Toplam: ${total}`);
process.exit(total === 0 ? 0 : 1);
