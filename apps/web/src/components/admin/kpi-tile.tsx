import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';

const nf = new Intl.NumberFormat('tr-TR');
const df = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

export function formatCount(n: number): string {
  return nf.format(n);
}

/** Milisaniye → "850 ms", "4,2 sn", "1,5 dk". */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${df.format(ms / 1000)} sn`;
  return `${df.format(ms / 60_000)} dk`;
}

export type KpiTone = 'neutral' | 'positive' | 'warning' | 'danger';

const VALUE_TONE: Record<KpiTone, string> = {
  neutral: 'text-text',
  positive: 'text-positive-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
};

export interface KpiTileProps {
  label: string;
  /** `null`/`undefined`: veri yok → "—" ve `unavailableHint`. Sayılar tr-TR biçimlenir. */
  value: number | string | null | undefined;
  /** Sayı biçimleyici (varsayılan binlik ayraçlı tam sayı). */
  format?: (n: number) => string;
  /** Değerin altında küçük açıklama (ör. "bugün +9"). */
  hint?: ReactNode;
  /** Değer null olduğunda gösterilen neden (ör. "Redis'e ulaşılamıyor"). */
  unavailableHint?: string;
  tone?: KpiTone;
  /** Metin değerleri (`string`) varsayılan olarak başlık yazı tipiyle gösterilir; biçimlenmiş sayı metniyse true. */
  numeric?: boolean;
  /** Etiket bu listeye bağlantı olur. */
  href?: string;
  className?: string;
}

/**
 * Tek KPI karosu. `KpiGrid` içinde 1px ayraçlı ızgara oluşturur (Plan 06 Dashboard `Metric` deseni).
 * Sayılar Geist Mono (`.num`), etiketler gövde yazı tipiyle; `role="group"` + `aria-label` ile ekran okuyucuya tek birim.
 */
export function KpiTile({ label, value, format = formatCount, hint, unavailableHint, tone = 'neutral', numeric = false, href, className }: KpiTileProps) {
  const missing = value === null || value === undefined;
  const shown = missing ? '—' : typeof value === 'number' ? format(value) : value;
  return (
    <div role="group" aria-label={label} className={cn('flex min-w-0 flex-col gap-1.5 bg-surface px-5 py-4', className)}>
      {href ? (
        <Link href={href} className="w-fit rounded-sm text-[13px] text-muted underline-offset-4 hover:text-text hover:underline">
          {label}
        </Link>
      ) : (
        <span className="text-[13px] text-muted">{label}</span>
      )}
      <span
        className={cn(
          'truncate text-[26px] font-medium leading-none tracking-tight',
          typeof value === 'string' && !numeric ? 'font-display' : 'num',
          missing ? 'text-muted' : VALUE_TONE[tone],
        )}
      >
        {shown}
      </span>
      {missing && unavailableHint ? (
        <span className="text-xs text-warning-text">{unavailableHint}</span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/** KPI karoları için 1px ayraçlı ızgara. */
export function KpiGrid({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label={label}
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4',
        className,
      )}
    >
      {children}
    </section>
  );
}
