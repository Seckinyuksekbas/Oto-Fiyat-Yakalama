'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCatalogMakes, useCatalogModels, type OpportunityFilters } from '@/lib/panel-queries';

const ALL = '__all__';

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel = 'Tümü',
  disabled,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-muted">
        {label}
      </span>
      <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)} disabled={disabled}>
        <SelectTrigger aria-labelledby={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Yazma durunca `delay` ms sonra bildirir. Dışarıdan gelen değer, taslağın normalize hâliyle aynıysa
 * taslak korunur (sondaki boşluk yazarken silinmez).
 */
function useDebouncedDraft(value: string, commit: (v: string) => void, normalize: (v: string) => string = (v) => v, delay = 400) {
  const [draft, setDraft] = useState(value);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const last = useRef(value);
  useEffect(() => {
    last.current = value;
    if (normalize(draftRef.current) !== value) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (normalize(draft) === last.current) return;
    const t = setTimeout(() => {
      last.current = normalize(draft);
      commitRef.current(draft);
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, delay]);
  return [draft, setDraft] as const;
}

const SORTS = [
  { value: 'score', label: 'Skor' },
  { value: 'recent', label: 'En yeni' },
  { value: 'discount', label: 'İndirim' },
];

export interface FiltersBarProps {
  value: OpportunityFilters;
  onChange: (patch: OpportunityFilters) => void;
  onReset: () => void;
}

export function FiltersBar({ value, onChange, onReset }: FiltersBarProps) {
  const makes = useCatalogMakes();
  const models = useCatalogModels(value.make);
  const [city, setCity] = useDebouncedDraft(
    value.city ?? '',
    (v) => onChange({ city: v.trim() || undefined }),
    (v) => v.trim(),
  );
  const [maxPrice, setMaxPrice] = useDebouncedDraft(value.maxPrice ?? '', (v) =>
    onChange({ maxPrice: v.replace(/\D/g, '') || undefined }),
  );
  const [score, setScore] = useDebouncedDraft(value.minScore ?? '60', (v) =>
    onChange({ minScore: v === '60' ? undefined : v }),
  );
  const activeCount = Object.entries(value).filter(([k, v]) => v !== undefined && !(k === 'sort' && v === 'score')).length;
  const dirty = activeCount > 0;
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="flex flex-col gap-2">
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen((o) => !o)}
      className="flex h-11 items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium sm:hidden"
    >
      <span className="flex items-center gap-2">
        <SlidersHorizontal aria-hidden className="size-4 text-muted" />
        Filtreler
        {activeCount > 0 && (
          <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">
            {activeCount}
            <span className="sr-only"> etkin filtre</span>
          </span>
        )}
      </span>
      <ChevronDown aria-hidden className={'size-4 text-muted transition-transform ' + (open ? 'rotate-180' : '')} />
    </button>
    <form
      id={panelId}
      role="search"
      aria-label="Fırsat filtreleri"
      onSubmit={(e) => e.preventDefault()}
      className={(open ? 'grid' : 'hidden sm:grid') + ' gap-3 rounded-lg border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4'}
    >
      <FilterSelect
        label="Marka"
        value={value.make}
        onChange={(make) => onChange({ make, model: undefined })}
        options={(makes.data?.items ?? []).map((m) => ({ value: m.make, label: `${m.make} (${m.count})` }))}
        allLabel="Tüm markalar"
      />
      <FilterSelect
        label="Model"
        value={value.model}
        onChange={(model) => onChange({ model })}
        options={(value.make ? (models.data?.items ?? []) : []).map((m) => ({ value: m.model, label: `${m.model} (${m.count})` }))}
        allLabel={value.make ? 'Tüm modeller' : 'Önce marka seçin'}
        disabled={!value.make}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-city" className="text-xs font-medium text-muted">
          Şehir
        </label>
        <Input id="f-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Tüm şehirler" maxLength={100} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-price" className="text-xs font-medium text-muted">
          En yüksek fiyat (₺)
        </label>
        <Input
          id="f-price"
          inputMode="numeric"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value.replace(/\D/g, '').slice(0, 15))}
          placeholder="Sınır yok"
          className="tnum"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-score" className="flex justify-between text-xs font-medium text-muted">
          <span>En düşük skor</span>
          <span className="num text-text">{score}</span>
        </label>
        <input
          id="f-score"
          type="range"
          min={60}
          max={100}
          step={1}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          className="h-10 w-full accent-[var(--color-accent)]"
        />
      </div>
      <FilterSelect
        label="Güven"
        value={value.confidence}
        onChange={(confidence) => onChange({ confidence })}
        options={[
          { value: 'MEDIUM', label: 'Orta' },
          { value: 'HIGH', label: 'Yüksek' },
        ]}
        allLabel="Orta ve üstü"
      />
      <div className="flex flex-col gap-1.5">
        <span id="f-sort" className="text-xs font-medium text-muted">
          Sıralama
        </span>
        <div role="radiogroup" aria-labelledby="f-sort" className="flex h-10 overflow-hidden rounded-md border border-border-strong">
          {SORTS.map((s) => {
            const on = (value.sort ?? 'score') === s.value;
            return (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ sort: s.value === 'score' ? undefined : s.value })}
                className={
                  'flex-1 px-2 text-sm transition-colors ' +
                  (on ? 'bg-accent font-medium text-accent-fg' : 'bg-surface text-muted hover:text-text')
                }
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-end">
        <Button variant="ghost" onClick={onReset} disabled={!dirty} className="w-full">
          <RotateCcw aria-hidden />
          Filtreleri sıfırla
        </Button>
      </div>
    </form>
    </div>
  );
}
