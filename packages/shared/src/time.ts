const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000; // Türkiye UTC+3, yaz saati yok
const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfIstanbulDay(d: Date): Date {
  return new Date(Math.floor((d.getTime() + ISTANBUL_OFFSET_MS) / DAY_MS) * DAY_MS - ISTANBUL_OFFSET_MS);
}
