'use client';
import { useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Paged } from '@/lib/admin-api';
import { cn } from '@/lib/cn';

const nf = new Intl.NumberFormat('tr-TR');

/** Kart listesine geçiş: ≤ 768 px. */
const WIDE_QUERY = '(min-width: 769px)';

/** Sunucuda ve ilk istemci boyamasında `false` (kart listesi); tarayıcıda `matchMedia` ile güncellenir. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export interface DataColumn<T> {
  id: string;
  /** Sütun başlığı; kart görünümünde alan etiketi olarak da kullanılır. */
  header: string;
  cell(row: T): ReactNode;
  /** Başlık sıralama düğmesine dönüşür (`onSortChange` gerekir; API'nin sıralama beyaz listesiyle eşleşmeli). */
  sortable?: boolean;
  /** Sağa hizalı, Geist Mono. Yalnızca sayısal sütunlar için. */
  numeric?: boolean;
  /** Kart görünümünde başlık satırı (etiketsiz, kalın). İlk `primary` sütun kullanılır. */
  primary?: boolean;
  hideOnCard?: boolean;
  /** Başlık görsel olarak gizlenir (ör. işlem sütunu). */
  srOnlyHeader?: boolean;
  className?: string;
}

export interface SortState {
  id: string;
  dir: 'asc' | 'desc';
}

export interface DataTableSelection<T, K extends string | number> {
  selected: Set<K>;
  onChange(next: Set<K>): void;
  /** Satır onay kutusunun erişilebilir adı: "<rowLabel> seç". */
  rowLabel(row: T): string;
  isSelectable?(row: T): boolean;
}

export interface DataTableEmpty {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}

export interface DataTableProps<T, K extends string | number = string | number> {
  /** Tablo başlığı (görünmez `caption`) ve kart listesinin erişilebilir adı. */
  caption: string;
  columns: DataColumn<T>[];
  rowKey(row: T): K;
  /** Offset sayfalı yanıt `{ items, total }` (spec §7). */
  data?: Paged<T>;
  isPending?: boolean;
  /** Arka planda yeni sayfa yükleniyor (keepPreviousData). */
  isFetching?: boolean;
  isError?: boolean;
  errorTitle?: string;
  errorDescription?: ReactNode;
  onRetry?(): void;
  empty?: DataTableEmpty;
  page: number;
  pageSize: number;
  onPageChange(page: number): void;
  sort?: SortState;
  onSortChange?(sort: SortState): void;
  selection?: DataTableSelection<T, K>;
}

/**
 * Admin tablosu: offset sayfalama, kontrollü sıralama, isteğe bağlı çoklu seçim, yükleme/boş/hata durumları.
 * Geniş ekranda `<table>`, ≤ 768 px'te kart listesi (yalnızca biri bağlanır). Durum (sayfa, süzgeç, sıralama)
 * çağıranda tutulur; tablo yalnızca görüntüler ve olay bildirir.
 */
export function DataTable<T, K extends string | number = string | number>(props: DataTableProps<T, K>) {
  const { caption, data, isPending, isError, page, pageSize, onPageChange } = props;
  const wide = useMediaQuery(WIDE_QUERY);

  if (isError && !data) {
    return (
      <EmptyState
        title={props.errorTitle ?? `${caption} yüklenemedi`}
        description={props.errorDescription ?? 'Bağlantınızı kontrol edip yeniden deneyin.'}
        action={
          props.onRetry ? (
            <Button variant="secondary" onClick={props.onRetry}>
              Yeniden dene
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (isPending || !data) {
    return (
      <div aria-label={`${caption} yükleniyor`} aria-busy="true" className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (data.items.length === 0) {
    const e = props.empty ?? { title: 'Kayıt yok' };
    return (
      <>
        <EmptyState icon={e.icon} title={e.title} description={e.description} action={e.action} />
        {page > 1 ? <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={onPageChange} force /> : null}
      </>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3 transition-opacity', props.isFetching && 'opacity-70')} aria-busy={props.isFetching || undefined}>
      {wide ? <TableView {...props} data={data} /> : <CardView {...props} data={data} />}
      <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={onPageChange} />
    </div>
  );
}

// ---------------------------------------------------------------- seçim yardımcıları

function selectionState<T, K extends string | number>(rows: T[], props: DataTableProps<T, K>) {
  const sel = props.selection;
  if (!sel) return null;
  const selectable = rows.filter((r) => sel.isSelectable?.(r) ?? true).map((r) => props.rowKey(r));
  const picked = selectable.filter((k) => sel.selected.has(k)).length;
  const all = selectable.length > 0 && picked === selectable.length;
  const toggleAll = () => {
    const next = new Set(sel.selected);
    if (all) selectable.forEach((k) => next.delete(k));
    else selectable.forEach((k) => next.add(k));
    sel.onChange(next);
  };
  const toggle = (k: K) => {
    const next = new Set(sel.selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    sel.onChange(next);
  };
  return { sel, all, some: picked > 0 && !all, toggleAll, toggle, empty: selectable.length === 0 };
}

const checkboxCls = 'size-4 cursor-pointer accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40';

// ---------------------------------------------------------------- tablo

function SortIcon({ dir }: { dir?: 'asc' | 'desc' }) {
  if (dir === 'asc') return <ArrowUp aria-hidden className="size-3.5" />;
  if (dir === 'desc') return <ArrowDown aria-hidden className="size-3.5" />;
  return <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />;
}

function TableView<T, K extends string | number>(props: DataTableProps<T, K> & { data: Paged<T> }) {
  const { caption, columns, data, sort, onSortChange, rowKey } = props;
  const s = selectionState(data.items, props);

  const nextSort = (id: string): SortState =>
    sort?.id === id ? { id, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: 'asc' };

  return (
    <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            {s ? (
              <th scope="col" className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Sayfadakilerin tümünü seç"
                  className={checkboxCls}
                  checked={s.all}
                  disabled={s.empty}
                  ref={(el) => {
                    if (el) el.indeterminate = s.some;
                  }}
                  onChange={s.toggleAll}
                />
              </th>
            ) : null}
            {columns.map((c) => {
              const active = sort?.id === c.id ? sort.dir : undefined;
              const canSort = c.sortable && onSortChange;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={canSort ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}
                  className={cn('px-3 py-2.5 font-medium whitespace-nowrap', c.numeric && 'text-right', c.className)}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(nextSort(c.id))}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm transition-colors hover:text-text',
                        active && 'text-text',
                        c.numeric && 'flex-row-reverse',
                      )}
                    >
                      {c.header}
                      <SortIcon dir={active} />
                    </button>
                  ) : (
                    <span className={cn(c.srOnlyHeader && 'sr-only')}>{c.header}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.items.map((row) => {
            const k = rowKey(row);
            const selectable = s ? (s.sel.isSelectable?.(row) ?? true) : false;
            return (
              <tr key={k} className="border-t border-border bg-surface align-middle transition-colors hover:bg-surface-2/60">
                {s ? (
                  <td className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`${s.sel.rowLabel(row)} seç`}
                      className={checkboxCls}
                      checked={s.sel.selected.has(k)}
                      disabled={!selectable}
                      onChange={() => s.toggle(k)}
                    />
                  </td>
                ) : null}
                {columns.map((c) => (
                  <td key={c.id} className={cn('px-3 py-2.5', c.numeric && 'num text-right', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- kart listesi (≤ 768 px)

function CardView<T, K extends string | number>(props: DataTableProps<T, K> & { data: Paged<T> }) {
  const { caption, columns, data, rowKey } = props;
  const s = selectionState(data.items, props);
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary && !c.hideOnCard);

  return (
    <div className="flex flex-col gap-2">
      {s && !s.empty ? (
        <label className="flex h-9 items-center gap-2 px-1 text-sm text-muted">
          <input
            type="checkbox"
            className={checkboxCls}
            checked={s.all}
            ref={(el) => {
              if (el) el.indeterminate = s.some;
            }}
            onChange={s.toggleAll}
          />
          Sayfadakilerin tümünü seç
        </label>
      ) : null}
      <ul aria-label={caption} className="flex flex-col gap-2">
        {data.items.map((row) => {
          const k = rowKey(row);
          const selectable = s ? (s.sel.isSelectable?.(row) ?? true) : false;
          return (
            <li key={k} className="flex gap-3 rounded-lg border border-border bg-surface p-4">
              {s ? (
                <input
                  type="checkbox"
                  aria-label={`${s.sel.rowLabel(row)} seç`}
                  className={cn(checkboxCls, 'mt-1')}
                  checked={s.sel.selected.has(k)}
                  disabled={!selectable}
                  onChange={() => s.toggle(k)}
                />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                {primary ? <div className="min-w-0 font-medium">{primary.cell(row)}</div> : null}
                {rest.length > 0 ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    {rest.map((c) => (
                      <div key={c.id} className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-xs text-muted">{c.header}</dt>
                        <dd className={cn('min-w-0', c.numeric && 'num')}>{c.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- sayfalama

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  force = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
  /** Tek sayfa olsa da göster (ör. boş son sayfadan geri dönmek için). */
  force?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1 && !force) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Sayfalama" className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
      <p>
        <span className="num text-text">
          {nf.format(from)}–{nf.format(to)}
        </span>{' '}
        / <span className="num">{nf.format(total)}</span> kayıt
      </p>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" aria-label="Önceki sayfa" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <span className="px-2">
          Sayfa <span className="num text-text">{nf.format(page)}</span> / <span className="num">{nf.format(pages)}</span>
        </span>
        <Button variant="ghost" size="sm" aria-label="Sonraki sayfa" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
