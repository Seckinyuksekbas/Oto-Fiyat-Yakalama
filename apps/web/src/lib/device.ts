const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function maskV4(ip: string): string {
  const [a, b] = ip.split('.');
  return `${a}.${b}.x.x`;
}

/**
 * IP'nin son kısmını gizler: 88.247.12.34 -> 88.247.x.x; IPv4 eşlemeli IPv6 aynı biçimde;
 * IPv6'da ilk iki öbek korunur (sıkıştırılmış biçim dahil); ::1 yerel adrestir.
 */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return 'Bilinmiyor';
  const raw = ip.split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped?.[1]) return maskV4(mapped[1]);
  if (IPV4.test(raw)) return maskV4(raw);
  if (!raw.includes(':')) return 'Bilinmiyor';
  if (raw === '::1') return '::1 (yerel)';
  if (raw.startsWith('::')) return '::x:x';
  const head = (raw.split('::')[0] ?? '').split(':').filter(Boolean);
  return `${head.slice(0, 2).join(':')}:x:x`;
}

/** Ham User-Agent'tan "Tarayıcı · Sistem" üretir. */
export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Bilinmeyen cihaz';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? 'Bilinmeyen cihaz';
}
