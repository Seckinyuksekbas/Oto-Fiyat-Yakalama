const TL = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const DT = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatTl(v: string | bigint): string {
  return TL.format(typeof v === 'bigint' ? v : BigInt(v));
}

export function formatIstanbulDateTime(iso: string): string {
  const parts = Object.fromEntries(DT.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isPrivateIPv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(h: string): boolean {
  if (h === '::' || h === '::1' || h.startsWith('::ffff:')) return true;
  const first = parseInt(h.split(':')[0] || '0', 16);
  return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
}

/** Telegram URL butonları yalnızca herkese açık http(s) adresleri kabul eder. */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) return !isPrivateIPv6(host.slice(1, -1));
    host = host.replace(/\.+$/, '');
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    return !isPrivateIPv4(host);
  } catch {
    return false;
  }
}
