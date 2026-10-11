import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ErrorCode } from '@oto/shared';
import { AppError } from '../errors/app-error';

export interface SsrfOptions {
  allowPrivate: boolean;
  /** Test için enjekte edilebilir; tüm çözülen adresleri döndürmelidir. */
  lookup?: (host: string) => Promise<string[]>;
}

const fail = (msg: string) => new AppError(ErrorCode.VALIDATION_FAILED, 400, msg);

async function defaultLookup(host: string): Promise<string[]> {
  const rows = await dnsLookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** IPv6 metnini 8 adet 16-bit gruba açar (::, gömülü IPv4 desteği). */
function expandV6(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n)) ? groups : null;
}

function ipv6Private(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // ayrıştırılamıyorsa güvenli taraf
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return ipv4Private(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // ::ffff:a.b.c.d
  }
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-uyumlu (::a.b.c.d), kullanım dışı
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) return ipv6Private(ip);
  return true;
}

/**
 * Yalnızca http(s), kimlik bilgisiz URL; allowPrivate=false iken tüm çözülen adresler genel olmalıdır.
 * Not: doğrulama ile bağlantı anı arasında DNS değişebilir (rebinding); istek tarafında da kontrol gerekir.
 */
export async function assertPublicHttpUrl(url: string, opts: SsrfOptions): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw fail('Geçersiz URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('Yalnızca http/https URL kabul edilir');
  if (u.username || u.password) throw fail('URL kimlik bilgisi içeremez');
  if (opts.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw fail('Geçersiz URL');
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await (opts.lookup ?? defaultLookup)(host);
    } catch {
      throw fail('Ana makine adı çözümlenemedi');
    }
  }
  if (addrs.length === 0) throw fail('Ana makine adı çözümlenemedi');
  if (addrs.some(isPrivateAddress)) throw fail('URL iç ağ adresine işaret ediyor');
}
