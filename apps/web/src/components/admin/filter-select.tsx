'use client';
import { useId } from 'react';
import { cn } from '@/lib/cn';

/** Yerel `<select>` stili (Plan 06 bildirim süzgeçleriyle aynı görünüm). */
export const adminSelectCls =
  'h-9 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm text-text disabled:opacity-50';

export interface FilterOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface FilterSelectProps {
  label: string;
  value: string | undefined;
  /** Boş seçim `undefined` olarak bildirilir (API `.strict()` şemaları boş değeri reddeder). */
  onChange(value: string | undefined): void;
  options: FilterOption[];
  /** "Tümü" seçeneğinin metni; `null` verilirse boş seçenek yoktur. */
  allLabel?: string | null;
  className?: string;
  disabled?: boolean;
}

/**
 * Admin tablo süzgeci: üstte etiket, altında yerel `<select>` (mobilde yerel seçici, testte `selectOptions`).
 * Etiket `htmlFor` ile bağlıdır; seçenek metinleri erişilebilir ada karışmaz.
 */
export function FilterSelect({ label, value, onChange, options, allLabel = 'Tümü', className, disabled }: FilterSelectProps) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[13px] text-muted">
        {label}
      </label>
      <select
        id={id}
        className={adminSelectCls}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {allLabel !== null ? <option value="">{allLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
