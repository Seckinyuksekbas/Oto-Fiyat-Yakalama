import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** URL güvenli değil (şema, kimlik bilgisi, çözümleme ya da iç ağ adresi). */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export interface SsrfOptions {
  allowPrivate: boolean;
  /** Proxy URL'leri gibi kimlik bilgisi taşıması meşru olan URL için (varsayılan: reddet). */
  allowCredentials?: boolean;
  /** Test için enjekte edilebilir; tüm çözülen adresleri döndürmelidir. */
  lookup?: (host: string) => Promise<string[]>;
}

async function defaultLookup(host: string): Promise<string[]> {
  const rows = await dnsLookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

function ipv4Private(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protokol atamaları
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // kıyaslama
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
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

const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function ipv6Private(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // ayrıştırılamıyorsa güvenli taraf
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return ipv4Private(v4of(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-uyumlu (::a.b.c.d), kullanım dışı
  // NAT64 64:ff9b::/96 (RFC 6052): gömülü IPv4 son 32 bit
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return ipv4Private(v4of(g[6], g[7]));
  // NAT64 yerel kullanım 64:ff9b:1::/48: IPv4 bitleri 48-63 ve 72-87 (RFC 6052 madde 2.2)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return ipv4Private(v4of(g[3], ((g[4] & 0xff) << 8) | (g[5] >> 8)));
  // 6to4 2002::/16: IPv4 bitleri 16-47
  if (g[0] === 0x2002) return ipv4Private(v4of(g[1], g[2]));
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // dokümantasyon
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

/** Çözümlenmiş bir IP iç/özel/ayrılmış aralıkta mı (geçersiz IP de güvenli tarafta true). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) return ipv6Private(ip);
  return true;
}

/**
 * Yalnızca http(s), kimlik bilgisiz URL; allowPrivate=false iken tüm çözülen adresler genel olmalıdır.
 * Doğrulama anı ile bağlantı anı arasında DNS değişebilir; bağlantı tarafında da lookup denetimi gerekir.
 */
export async function assertPublicHttpUrl(url: string, opts: SsrfOptions): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UnsafeUrlError('Geçersiz URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('Yalnızca http/https URL kabul edilir');
  if (!opts.allowCredentials && (u.username || u.password)) throw new UnsafeUrlError('URL kimlik bilgisi içeremez');
  if (opts.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('Geçersiz URL');
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await (opts.lookup ?? defaultLookup)(host);
    } catch {
      throw new UnsafeUrlError('Ana makine adı çözümlenemedi');
    }
  }
  if (addrs.length === 0) throw new UnsafeUrlError('Ana makine adı çözümlenemedi');
  if (addrs.some(isPrivateAddress)) throw new UnsafeUrlError('URL iç ağ adresine işaret ediyor');
}
