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
 * Content-Security-Policy. `script-src`'e asla `'unsafe-inline'` girmez; `'unsafe-eval'` yalnız dev'de
 * (React Refresh). `nonce` verilirse Next'in kendi satır içi betikleri (`self.__next_f.push`) ve tema betiği
 * için `'nonce-…'` eklenir; tema hash'i her durumda durur. `connect-src 'self'` aynı kökenli `/api` rewrite'ı
 * üzerinden SSE'yi de kapsar. HSTS burada değil, Caddy'de.
 */
export function buildCsp({ dev, nonce }: { dev: boolean; nonce?: string }): string {
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
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
