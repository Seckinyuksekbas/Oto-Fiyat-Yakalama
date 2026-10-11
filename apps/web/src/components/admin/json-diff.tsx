'use client';
import { useState } from 'react';
import { EyeOff } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Denetim kaydı önce/sonra farkı. JSON hiçbir zaman HTML olarak yorumlanmaz: her değer `JSON.stringify` çıktısı olarak
 * React metin düğümüne yazılır. İç içe nesneler nokta yollarına düzleştirilir (`limits.channels`); diziler tek değerdir.
 * Silinen kullanıcılarda API önce/sonra yerine `{ redacted: true }` döndürür; o taraf "gizli" gösterilir.
 */

type Kind = 'added' | 'removed' | 'changed' | 'same' | 'hidden';

const KIND: Record<Kind, { label: string; cls: string }> = {
  added: { label: 'Eklendi', cls: 'text-positive-text' },
  removed: { label: 'Kaldırıldı', cls: 'text-danger-text' },
  changed: { label: 'Değişti', cls: 'text-warning-text' },
  same: { label: 'Aynı', cls: 'text-muted' },
  hidden: { label: 'Gizli', cls: 'text-muted' },
};

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function isRedacted(v: unknown): boolean {
  return isPlain(v) && v.redacted === true;
}

const MAX_DEPTH = 6;

/** Nesneyi `yol → değer` eşlemesine düzleştirir. Boş nesne ve diziler yaprak sayılır. */
export function flattenJson(v: unknown, prefix = '', depth = 0, out = new Map<string, unknown>()): Map<string, unknown> {
  if (v === undefined) return out;
  if (isPlain(v) && Object.keys(v).length > 0 && depth < MAX_DEPTH) {
    for (const [k, child] of Object.entries(v)) flattenJson(child, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    return out;
  }
  out.set(prefix, v);
  return out;
}

const show = (v: unknown): string => {
  if (v === undefined) return '—';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

export interface DiffRow {
  path: string;
  kind: Kind;
  before: unknown;
  after: unknown;
}

export function diffJson(before: unknown, after: unknown): DiffRow[] {
  const hideBefore = isRedacted(before);
  const hideAfter = isRedacted(after);
  const a = hideBefore || before === null ? new Map<string, unknown>() : flattenJson(before);
  const b = hideAfter || after === null ? new Map<string, unknown>() : flattenJson(after);
  const paths = [...a.keys(), ...[...b.keys()].filter((k) => !a.has(k))];
  return paths.map((path) => {
    const inA = a.has(path);
    const inB = b.has(path);
    let kind: Kind;
    if ((!inA && hideBefore) || (!inB && hideAfter)) kind = 'hidden';
    else if (!inA) kind = 'added';
    else if (!inB) kind = 'removed';
    else kind = show(a.get(path)) === show(b.get(path)) ? 'same' : 'changed';
    return { path, kind, before: a.get(path), after: b.get(path) };
  });
}

function Value({ v, hidden }: { v: unknown; hidden: boolean }) {
  if (hidden) return <span className="text-muted">gizli</span>;
  if (v === undefined) return <span className="text-muted">—</span>;
  return <code className="font-mono text-[12.5px] break-all whitespace-pre-wrap text-text">{show(v)}</code>;
}

export function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const [showSame, setShowSame] = useState(false);
  const hideBefore = isRedacted(before);
  const hideAfter = isRedacted(after);
  const rows = diffJson(before, after);
  const same = rows.filter((r) => r.kind === 'same').length;
  const visible = showSame ? rows : rows.filter((r) => r.kind !== 'same');
  const nothing = (before === null || before === undefined) && (after === null || after === undefined);

  return (
    <div className="flex flex-col gap-3">
      {hideBefore || hideAfter ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
          <EyeOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          {hideBefore && hideAfter
            ? 'Önceki ve sonraki değerler gizlendi: hesap silindiğinde kişisel veriler kayıttan kaldırılır.'
            : hideBefore
              ? 'Önceki değer gizlendi: hesap silindiğinde kişisel veriler kayıttan kaldırılır.'
              : 'Sonraki değer gizlendi: hesap silindiğinde kişisel veriler kayıttan kaldırılır.'}
        </p>
      ) : null}
      {nothing ? (
        <p className="text-[13px] text-muted">Bu kayıtta önce/sonra ayrıntısı tutulmamış.</p>
      ) : rows.length === 0 ? null : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Önce ve sonra</caption>
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Alan</th>
                <th scope="col" className="px-3 py-2 font-medium">Değişim</th>
                <th scope="col" className="px-3 py-2 font-medium">Önce</th>
                <th scope="col" className="px-3 py-2 font-medium">Sonra</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr className="border-t border-border">
                  <td colSpan={4} className="px-3 py-2.5 text-[13px] text-muted">
                    Alanlarda değişiklik yok.
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <tr key={r.path || '(değer)'} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium break-all">
                      {r.path || '(değer)'}
                    </th>
                    <td className={cn('px-3 py-2 text-[13px] whitespace-nowrap', KIND[r.kind].cls)}>{KIND[r.kind].label}</td>
                    <td className="px-3 py-2">
                      <Value v={r.before} hidden={hideBefore} />
                    </td>
                    <td className="px-3 py-2">
                      <Value v={r.after} hidden={hideAfter} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {same > 0 ? (
        <button
          type="button"
          onClick={() => setShowSame((s) => !s)}
          className="w-fit rounded-sm text-[13px] text-muted underline-offset-4 hover:text-text hover:underline"
        >
          {showSame ? 'Değişmeyen alanları gizle' : `Değişmeyen ${same} alanı göster`}
        </button>
      ) : null}
    </div>
  );
}
