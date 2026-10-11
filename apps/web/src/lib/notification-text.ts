import type { MatchNotificationPayload, SecurityNotificationPayload } from '@oto/shared';
import { formatTl } from './format';

/** `GET /me/notifications` öğesi (ve SSE `notification` olayı) biçimi. */
export interface NotificationView {
  id: number;
  kind: 'MATCH' | 'SECURITY' | 'SYSTEM_ALERT' | string;
  channel: string;
  status: string;
  attempts?: number;
  lastError?: string | null;
  payload: unknown;
  sentAt?: string | null;
  readAt?: string | null;
  createdAt: string;
}

export const SECURITY_TEXT: Record<SecurityNotificationPayload['type'], string> = {
  TELEGRAM_LINKED: 'Telegram hesabınız bağlandı',
  TELEGRAM_UNLINKED: 'Telegram sohbetiniz başka bir hesaba bağlandı',
  TELEGRAM_DISABLED: 'Telegram bildirimleri durduruldu (bot engellendi veya sohbet bulunamadı)',
  REFRESH_REUSED: 'Güvenlik: oturumunuz başka bir yerden kullanıldığı için sonlandırıldı',
};

export const MATCH_REASON_TITLE: Record<MatchNotificationPayload['reason'], string> = {
  NEW: 'Yeni',
  PRICE_DROP: 'Fiyat düştü',
  RELIST: 'Yeniden yayında',
};

export function asMatch(n: NotificationView): MatchNotificationPayload | null {
  const p = n.payload as Partial<MatchNotificationPayload> | null;
  return n.kind === 'MATCH' && p && p.type === 'MATCH' && p.listing ? (p as MatchNotificationPayload) : null;
}

export function asSecurity(n: NotificationView): SecurityNotificationPayload | null {
  const p = n.payload as Partial<SecurityNotificationPayload> | null;
  return n.kind === 'SECURITY' && p && typeof p.type === 'string' ? (p as SecurityNotificationPayload) : null;
}

export function matchLabel(p: MatchNotificationPayload): string {
  return [p.listing.make, p.listing.model, p.listing.trim].filter(Boolean).join(' ') + ` · ${p.listing.year}`;
}

/** "Fiyat düştü 1.010.000 → 960.000 ₺" gibi neden rozeti metni. */
export function reasonBadge(p: MatchNotificationPayload): string {
  if (p.reason === 'PRICE_DROP' && p.previousPrice) {
    return `Fiyat düştü ${formatTl(p.previousPrice).replace(/\s₺$/, '')} → ${formatTl(p.listing.price)}`;
  }
  return MATCH_REASON_TITLE[p.reason];
}

/** Toast ve zil paneli için kısa başlık + açıklama. */
export function describeNotification(n: NotificationView): { title: string; detail?: string; href?: string } {
  const m = asMatch(n);
  if (m) {
    return {
      title: m.reason === 'NEW' ? 'Yeni eşleşme' : MATCH_REASON_TITLE[m.reason],
      detail: `${matchLabel(m)} · ${formatTl(m.listing.price)}`,
      href: `/app/ilan/${m.listing.id}`,
    };
  }
  const s = asSecurity(n);
  if (s) return { title: SECURITY_TEXT[s.type] ?? 'Güvenlik bildirimi' };
  return { title: 'Sistem bildirimi' };
}
