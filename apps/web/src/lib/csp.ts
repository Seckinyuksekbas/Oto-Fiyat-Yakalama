import { sha256, toBase64 } from './sha256';
import { themeInitScript } from './theme';

// Edge (middleware) ve Node'da çalışır: node:crypto kullanılmaz.
let cachedHash: string | undefined;

/** Satır içi tema betiğinin CSP kaynak ifadesi: `'sha256-<base64>'` (statik string → sabit). */
export function themeScriptHash(): string {
  cachedHash ??= `'sha256-${toBase64(sha256(themeInitScript))}'`;
  return cachedHash;
}

/** İstek başına CSP nonce'u: 128 bit, base64. */
export function generateNonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Boşlukla ayrılmış http(s) origin listesini (ör. `CSP_IMG_EXTRA`) doğrular ve normalize eder.
 * Yol, sorgu, joker (`*`), anahtar kelime ya da başka şema içeren girdi reddedilir; hata mesajı değeri yazdırmaz.
 */
export function parseCspOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? '').split(/\s+/).filter(Boolean);
  return entries.map((entry, i) => {
    const url = URL.canParse(entry) ? new URL(entry) : null;
    const ok =
      url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !entry.includes('*') &&
      url.username === '' &&
      url.password === '' &&
      `${url.origin}/` === `${entry.replace(/\/+$/, '')}/` &&
      url.origin !== 'null';
    if (!ok) throw new Error(`girdi #${i + 1} geçerli bir http(s) origin değil (yol/sorgu/joker olmadan, ör. https://img.example.com)`);
    return url.origin;
  });
}

/**
 * Content-Security-Policy. `script-src`'e asla `'unsafe-inline'` girmez; `'unsafe-eval'` yalnız dev'de
 * (React Refresh). `nonce` verilirse Next'in kendi satır içi betikleri (`self.__next_f.push`) ve tema betiği
 * için `'nonce-…'` eklenir; tema hash'i her durumda durur. `connect-src 'self'` aynı kökenli `/api` rewrite'ı
 * üzerinden SSE'yi de kapsar. HSTS burada değil, Caddy'de.
 */
export function buildCsp({
  dev,
  nonce,
  imgExtra = [],
}: {
  dev: boolean;
  nonce?: string;
  /** Ek görsel origin'leri (`CSP_IMG_EXTRA`, doğrulanmış). */
  imgExtra?: readonly string[];
}): string {
  const script = [
    "'self'",
    ...(nonce ? [`'nonce-${nonce}'`] : []),
    themeScriptHash(),
    ...(dev ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    // İlan fotoğrafları kaynak sitenin mutlak URL'leridir (<img>): her https kaynağına izin verilir;
    // dev'de yerel http kaynakları için http:. Ek http origin'leri (E2E demo-site) CSP_IMG_EXTRA ile.
    ['img-src', "'self'", 'data:', 'blob:', 'https:', ...(dev ? ['http:'] : []), ...imgExtra].join(' '),
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
