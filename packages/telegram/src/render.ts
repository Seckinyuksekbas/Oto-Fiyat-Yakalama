import type { MatchNotificationPayload } from '@oto/shared';
import type { InlineButton, InlineKeyboard } from './client';
import { escapeHtml, formatIstanbulDateTime, formatTl, isPublicHttpUrl } from './format';

const CONFIDENCE: Record<string, string> = { HIGH: 'Yüksek', MEDIUM: 'Orta', LOW: 'Düşük', INSUFFICIENT: 'Yetersiz' };
const FUEL: Record<string, string> = { GASOLINE: 'Benzin', DIESEL: 'Dizel', LPG: 'LPG', HYBRID: 'Hibrit', ELECTRIC: 'Elektrik', OTHER: 'Diğer' };
const GEAR: Record<string, string> = { MANUAL: 'Manuel', AUTOMATIC: 'Otomatik', SEMI_AUTOMATIC: 'Yarı otomatik' };
export const DISCLAIMER = 'Fiyat analizi tahminidir; aracın durumunu garanti etmez.';

const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;

function clip(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : `${chars.slice(0, Math.max(0, n)).join('')}…`;
}

export function renderMatchMessage(p: MatchNotificationPayload, opts: { publicBaseUrl: string }) {
  const { listing: l, analysis: a } = p;
  const photoUrl = l.imageUrl && isPublicHttpUrl(l.imageUrl) ? l.imageUrl : null;
  const limit = photoUrl ? CAPTION_LIMIT : MESSAGE_LIMIT;
  const isDeal = a.confidence !== 'INSUFFICIENT' && a.discountPct !== null && Math.round(a.discountPct * 100) >= 1;
  const tail = ` · Skor ${a.opportunityScore} · Güven: ${escapeHtml(CONFIDENCE[a.confidence] ?? a.confidence)}`;
  const head =
    p.reason === 'PRICE_DROP' && p.previousPrice
      ? `📉 <b>Fiyat düştü: ${formatTl(p.previousPrice)} → ${formatTl(l.price)} TL</b>`
      : p.reason === 'RELIST'
        ? '🔁 <b>Yeniden yayında</b>'
        : isDeal
          ? '🔥 <b>Fırsat</b>'
          : '🆕 <b>Yeni ilan</b>';
  const rawName = [l.make, l.model, l.trim].filter(Boolean).join(' ');
  const buildText = (name: string): string => {
  const lines = [
    head + tail,
    `<b>${name} · ${l.year}</b>`,
    `💰 ${formatTl(l.price)} TL` + (a.estimatedPrice && isDeal ? `   (Piyasa ≈ ${formatTl(a.estimatedPrice)} TL)` : ''),
  ];
  if (isDeal && a.priceDiff && BigInt(a.priceDiff) > 0n) lines.push(`📉 ${formatTl(a.priceDiff)} TL altında · %${Math.round((a.discountPct ?? 0) * 100)}`);
  lines.push(
    [`🛣 ${formatTl(BigInt(l.km))} km`, escapeHtml(FUEL[l.fuel] ?? l.fuel), escapeHtml(GEAR[l.transmission] ?? l.transmission), l.city ? escapeHtml(clip(l.city, 60)) : null]
      .filter(Boolean)
      .join(' · '),
  );
  if (a.comparableCount > 0) lines.push(`📊 ${a.comparableCount} benzer ilan ile karşılaştırıldı`);
  lines.push(`🕒 İlk görülme: ${formatIstanbulDateTime(l.firstSeenAt)}`, '', `<i>${DISCLAIMER}</i>`);
  return lines.join('\n');
  };
  let nameMax = Array.from(rawName).length;
  let text = buildText(escapeHtml(rawName));
  while (text.length > limit && nameMax > 0) {
    nameMax = Math.max(0, nameMax - Math.max(1, text.length - limit));
    text = buildText(escapeHtml(clip(rawName, nameMax)));
  }

  const row: InlineButton[] = [];
  if (isPublicHttpUrl(l.url)) row.push({ text: 'İlana git', url: l.url });
  row.push({ text: 'Favorile', callback_data: `fav:${l.id}` });
  const analysisUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/ilan/${l.id}`;
  if (isPublicHttpUrl(analysisUrl)) row.push({ text: 'Analizi gör', url: analysisUrl });
  const replyMarkup: InlineKeyboard = { inline_keyboard: [row] };
  return { text, photoUrl, replyMarkup };
}
