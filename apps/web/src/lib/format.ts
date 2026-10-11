/** Biçimlendirme yardımcıları. Para birimi her zaman `960.000 ₺`; tarihler Europe/Istanbul. */

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function formatTl(v: string | bigint | number): string {
  let s: string;
  if (typeof v === 'number') s = Number.isFinite(v) ? String(Math.trunc(v)) : '0';
  else s = String(v).split(/[.,]/)[0] ?? '0'; // kuruş/ondalık kısım atılır
  const neg = s.trim().startsWith('-');
  const digits = s.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '') || '0';
  return `${neg && digits !== '0' ? '-' : ''}${groupThousands(digits)}\u00A0₺`;
}

/** Bant etiketi için kısa biçim: `1,2 Mn ₺`, `960 B ₺`. */
export function formatShortTl(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const trim = (x: number) => String(Math.round(x * 10) / 10).replace('.', ',');
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000 || Math.round((abs / 1_000) * 10) / 10 >= 1000) return `${sign}${trim(abs / 1_000_000)}\u00A0Mn\u00A0₺`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}\u00A0B\u00A0₺`;
  return `${sign}${Math.round(abs)}\u00A0₺`;
}

export function formatKm(n: number): string {
  return `${groupThousands(String(Math.round(n)))} km`;
}

/** 0.2 → "%20 altında", -0.05 → "%5 üstünde". Yuvarlama sonucu 0 ise gösterilmez. */
export function formatDiscount(p: number | null): string | null {
  if (p === null || !Number.isFinite(p)) return null;
  const pct = Math.round(Math.abs(p) * 100);
  if (pct === 0) return null;
  return p > 0 ? `%${pct} altında` : `%${pct} üstünde`;
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Math.max(0, now.getTime() - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'az önce';
  if (min < 60) return `${min} dk önce`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} sa önce`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} gün önce`;
  if (days < 30) return `${Math.floor(days / 7)} hf önce`;
  if (days < 365) return `${Math.floor(days / 30)} ay önce`;
  return `${Math.floor(days / 365)} yıl önce`;
}

const ISTANBUL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatDateTime(iso: string): string {
  if (!Number.isFinite(new Date(iso).getTime())) return '—';
  const p = Object.fromEntries(ISTANBUL.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

export const CONFIDENCE_LABEL = {
  HIGH: 'Yüksek güven',
  MEDIUM: 'Orta güven',
  LOW: 'Düşük güven',
  INSUFFICIENT: 'Yetersiz veri',
} as const;

export const FUEL_LABEL: Record<string, string> = {
  GASOLINE: 'Benzin',
  DIESEL: 'Dizel',
  LPG: 'LPG',
  HYBRID: 'Hibrit',
  ELECTRIC: 'Elektrik',
  OTHER: 'Diğer',
};

export const GEAR_LABEL: Record<string, string> = {
  MANUAL: 'Manuel',
  AUTOMATIC: 'Otomatik',
  SEMI_AUTOMATIC: 'Yarı otomatik',
};

export const INSUFFICIENT_REASON_LABEL = {
  NO_LEVEL: 'yeterli benzer ilan yok',
  AFTER_OUTLIERS: 'uç değerler ayıklandıktan sonra emsal yetersiz',
  INVALID_TARGET: 'ilan fiyatı geçersiz',
  NONE: 'yeterli emsal yok',
} as const;

export interface BandGeometry {
  min: number;
  max: number;
  /** değer → eksen üzerinde 0..100 yüzde (sınırlara kırpılır) */
  pos: (v: number) => number;
  markerClamped: boolean;
}

/**
 * Eksen: min = max(min(Q1, fiyat) × 0,9, Q1 × 0,5); max = min(max(Q3, fiyat) × 1,1, Q3 × 1,5).
 * Fiyat eksen dışında kalırsa işaretçi sınıra çekilir (`markerClamped`).
 */
export function bandGeometry(input: {
  q1: number | null;
  median: number | null;
  q3: number | null;
  price: number;
}): BandGeometry | null {
  const { q1, q3, price } = input;
  if (q1 === null || q3 === null) return null;
  if (![q1, q3, price].every(Number.isFinite) || q1 <= 0 || q3 < q1) return null;
  const min = Math.max(Math.min(q1, price) * 0.9, q1 * 0.5);
  const max = Math.min(Math.max(q3, price) * 1.1, q3 * 1.5);
  const span = max - min;
  if (span <= 0) return null;
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));
  return { min, max, pos, markerClamped: price < min || price > max };
}
