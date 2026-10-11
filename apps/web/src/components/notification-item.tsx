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

export function deliveryLabel(n: NotificationView): string {
  const channel = CHANNEL_LABEL[n.channel] ?? n.channel;
  if (n.status === 'FAILED') return `${channel} · başarısız${n.lastError ? `: ${n.lastError}` : ''}`;
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
      <Link
        href={`/app/ilan/${l.id}`}
        onClick={() => onOpen?.(n)}
        data-unread={unread || undefined}
        className={row}
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
            <span className="truncate text-sm font-medium">{matchLabel(match)}</span>
            <Badge tone={match.reason === 'PRICE_DROP' ? 'positive' : 'accent'}>{reasonBadge(match)}</Badge>
            {match.limitExceeded ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex rounded-full">
                    <Badge tone="warning">Limit aşıldı</Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{LIMIT_HELP}</TooltipContent>
              </Tooltip>
            ) : null}
          </span>
          <span className="font-mono text-[15px] tabular-nums">{formatTl(l.price)}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
            <span>{match.profile.name}</span>
            <span aria-hidden>·</span>
            <span>{deliveryLabel(n)}</span>
            <span aria-hidden>·</span>
            <time dateTime={n.createdAt}>{formatRelative(n.createdAt)}</time>
          </span>
        </span>
      </Link>
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
          <span>{deliveryLabel(n)}</span>
          <span aria-hidden>·</span>
          <time dateTime={n.createdAt}>{formatRelative(n.createdAt)}</time>
        </span>
      </span>
    </button>
  );
}
