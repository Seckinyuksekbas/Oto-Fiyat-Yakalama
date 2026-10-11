/** IP'nin son kısmını gizler: 88.247.12.34 → 88.247.x.x, IPv6 → ilk iki öbek. */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return 'Bilinmiyor';
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return `${parts.slice(0, 2).join(':')}:x:x`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return 'Bilinmiyor';
  return `${parts[0]}.${parts[1]}.x.x`;
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
