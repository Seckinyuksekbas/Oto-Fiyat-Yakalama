'use client';
import Link from 'next/link';
import { Car, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { formatRelative, formatTl } from '@/lib/format';
import {
  asMatch,
  asSecurity,
  matchLabel,
  reasonBadge,
  SECURITY_TEXT,
  type NotificationView,
} from '@/lib/notification-text';

const CHANNEL_LABEL: Record<string, string> = { IN_APP: 'Uygulama içi', TELEGRAM: 'Telegram', EMAIL: 'E-posta' };
const STATUS_LABEL: Record<string, string> = { SENT: 'gönderildi', PENDING: 'bekliyor', SKIPPED_LIMIT: 'limit' };

const ERROR_LABEL: Record<string, string> = {
  CHANNEL_UNAVAILABLE: 'kanal kullanılamıyor',
  TELEGRAM_DISABLED: 'Telegram bildirimleri durduruldu',
  USER_INACTIVE: 'hesap etkin değil',
  CHANNEL_CONFIG_INVALID: 'kanal ayarı geçersiz',
  INVALID_PAYLOAD: 'bildirim içeriği geçersiz',
};

export function errorLabel(raw: string): string {
  const key = Object.keys(ERROR_LABEL).find((k) => raw.startsWith(k));
  if (key) return ERROR_LABEL[key]!;
  return raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
}

export function deliveryLabel(n: NotificationView): string {
  const channel = CHANNEL_LABEL[n.channel] ?? n.channel;
  if (n.status === 'FAILED') return `${channel} · başarısız${n.lastError ? `: ${errorLabel(n.lastError)}` : ''}`;
  return `${channel} · ${STATUS_LABEL[n.status] ?? n.status.toLowerCase()}`;
}

export function isUnread(n: NotificationView): boolean {
  return n.channel === 'IN_APP' && !n.readAt;
}

const LIMIT_HELP =
  'Günlük bildirim limitiniz doldu; bu fırsat Telegram’a gönderilmedi ama burada görebilirsiniz. Daha yüksek limit için planınızı yükseltin.';

function Dot({ unread }: { unread: boolean }) {
  return unread ? (
    <span role="img" aria-label="Okunmamış" className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
  ) : (
    <span aria-hidden className="mt-1.5 size-2 shrink-0" />
  );
}

export interface NotificationItemProps {
  n: NotificationView;
  /** Tıklamada okundu işaretlemek için. */
  onOpen?: (n: NotificationView) => void;
  className?: string;
}

/** Bildirimler sayfasındaki satır: MATCH için mini ilan kartı, SECURITY için düz metin. */
export function NotificationItem({ n, onOpen, className }: NotificationItemProps) {
  const unread = isUnread(n);
  const match = asMatch(n);
  const security = asSecurity(n);
  const row = cn(
    'flex w-full items-start gap-3 rounded-lg border border-border bg-surface p-3.5 text-left transition-colors hover:bg-surface-2/60 sm:p-4',
    unread && 'border-l-2 border-l-accent',
    className,
  );

  if (match) {
    const l = match.listing;
    return (
      <div
        data-unread={unread || undefined}
        className={cn(
          'flex items-start rounded-lg border border-border bg-surface transition-colors hover:bg-surface-2/60',
          unread && 'border-l-2 border-l-accent',
          className,
        )}
      >
        <Link
          href={`/app/ilan/${l.id}`}
          onClick={() => onOpen?.(n)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg p-3.5 sm:p-4"
        >
          <Dot unread={unread} />
          <span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2 text-border-strong">
            {l.imageUrl ? (
              <img src={l.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
            ) : (
              <Car aria-hidden className="size-5" />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="break-words text-sm font-medium">{matchLabel(match)}</span>
              <Badge tone={match.reason === 'PRICE_DROP' ? 'positive' : 'accent'}>{reasonBadge(match)}</Badge>
            </span>
            <span className="font-mono text-[15px] tabular-nums">{formatTl(l.price)}</span>
            <span className="flex flex-wrap items-center gap-x-2 break-words text-[13px] text-muted">
              <span>{match.profile.name}</span>
              <span aria-hidden>·</span>
              <span className="break-words">{deliveryLabel(n)}</span>
              <span aria-hidden>·</span>
              <time dateTime={n.createdAt}>{formatRelative(n.createdAt)}</time>
            </span>
          </span>
        </Link>
        {match.limitExceeded ? (
          <div className="shrink-0 py-3.5 pr-3.5 sm:py-4 sm:pr-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex rounded-full" aria-label="Limit aşıldı: açıklama">
                  <Badge tone="warning">Limit aşıldı</Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent>{LIMIT_HELP}</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    );
  }

  const text = security ? (SECURITY_TEXT[security.type] ?? 'Güvenlik bildirimi') : 'Sistem bildirimi';
  return (
    <button type="button" onClick={() => onOpen?.(n)} data-unread={unread || undefined} className={row}>
      <Dot unread={unread} />
      <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">
        <ShieldAlert className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-sm font-medium">{text}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
          <span className="break-words">{deliveryLabel(n)}</span>
          <span aria-hidden>·</span>
          <time dateTime={n.createdAt}>{formatRelative(n.createdAt)}</time>
        </span>
      </span>
    </button>
  );
}
