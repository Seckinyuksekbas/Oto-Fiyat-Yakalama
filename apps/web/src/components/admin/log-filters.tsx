'use client';
import { useId } from 'react';
import { Input } from '@/components/ui/input';

/** Denetim ve sistem logu süzgeçleri için ortak alanlar (etiketli metin ve tarih girişleri). */

export function TextFilter({
  label,
  value,
  onChange,
  maxLength = 100,
  className,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  maxLength?: number;
  className?: string;
  type?: 'text' | 'search';
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] text-muted">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={className ?? 'h-9 w-48'}
      />
    </div>
  );
}

export function DateFilter({ label, value, onChange, min }: { label: string; value: string; onChange(v: string): void; min?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] text-muted">
        {label}
      </label>
      <Input id={id} type="date" value={value} min={min} onChange={(e) => onChange(e.target.value)} className="h-9 w-40" />
    </div>
  );
}

/** "YYYY-MM-DD" (İstanbul günü) → günün başı / sonu ISO (API `z.string().datetime()` bekler). */
export function dayStartIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00+03:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function dayEndIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T23:59:59.999+03:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
