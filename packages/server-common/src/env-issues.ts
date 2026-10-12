/**
 * Ortam değişkeni doğrulama hatalarını biçimlendirir: değişken adı + neden.
 * Değer asla yazdırılmaz (zod'un enum mesajı alınan değeri içerdiği için yeniden yazılır).
 * zod'a bağımlılık olmaması için sorun tipi yapısal tanımlanır (ZodIssue ile uyumlu).
 */
export interface EnvIssueLike {
  code: string;
  path: readonly (string | number)[];
  message: string;
  options?: readonly unknown[];
  received?: unknown;
}

export function describeEnvIssue(issue: EnvIssueLike): string {
  if (issue.code === 'invalid_enum_value' && issue.options) {
    return `şunlardan biri olmalı: ${issue.options.map(String).join(' | ')}`;
  }
  if (issue.code === 'invalid_type' && issue.received === 'undefined') return 'zorunlu';
  if (issue.code === 'invalid_literal') return 'geçersiz değer';
  return issue.message;
}

export function formatEnvIssues(issues: readonly EnvIssueLike[]): string {
  return `Invalid environment: ${issues.map((i) => `${i.path.join('.')}: ${describeEnvIssue(i)}`).join('; ')}`;
}

/**
 * Production'da reddedilen yerel adresler: localhost, *.localhost, 127.0.0.0/8, ::1, ::, 0.0.0.0
 * ve IPv4-eşlemeli loopback (::ffff:127.x; URL ayrıştırıcısının ürettiği ::ffff:7fxx:xxxx biçimi dahil).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '::1', '::', '0.0.0.0', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0'].includes(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h);
}

/** URL'nin host'u loopback mı? Ayrıştırılamayan URL için `null`. */
export function urlHostIsLoopback(url: string): boolean | null {
  if (!URL.canParse(url)) return null;
  return isLoopbackHost(new URL(url).hostname);
}
