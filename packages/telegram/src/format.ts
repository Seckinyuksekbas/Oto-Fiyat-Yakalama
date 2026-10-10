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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Telegram URL butonları yalnızca herkese açık http(s) adresleri kabul eder. */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
