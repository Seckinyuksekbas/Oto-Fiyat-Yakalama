'use client';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCount, formatDurationMs } from './kpi-tile';
import type { Pct } from '@/lib/admin-ops-api';

const AXIS = { fontFamily: 'var(--font-mono)', fontSize: 11, fill: 'var(--color-muted)' } as const;
const LABEL = { fontFamily: 'var(--font-sans)', fontSize: 12, fill: 'var(--color-text)' } as const;

export interface LatencyGroup {
  key: string;
  label: string;
  pct: Pct;
}

const fmt = (v: number | null) => (v === null ? '—' : formatDurationMs(v));

/**
 * p50/p95 yatay çubuk grafiği + aynı verinin tablosu. Grafik görseldir (`aria-hidden`); ekran okuyucu ve kesin değer
 * isteyen yönetici için tablo asıl kaynaktır. Ölçümü olmayan grup grafikte boş, tabloda "—" görünür.
 */
export function LatencyChart({ title, caption, groups }: { title: string; caption: string; groups: LatencyGroup[] }) {
  const data = groups.map((g) => ({ label: g.label, p50: g.pct.p50 ?? 0, p95: g.pct.p95 ?? 0, n: g.pct.n }));
  const empty = groups.every((g) => g.pct.n === 0);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {empty ? (
        <p className="rounded-md border border-dashed border-border-strong/60 px-3 py-6 text-center text-[13px] text-muted">
          Bu aralıkta gönderilmiş eşleşme bildirimi yok.
        </p>
      ) : (
        <div aria-hidden className="h-[170px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
              <CartesianGrid stroke="var(--color-border)" horizontal={false} />
              <XAxis type="number" tickFormatter={(v: number) => formatDurationMs(v)} tick={AXIS} stroke="var(--color-border-strong)" tickLine={false} />
              <YAxis type="category" dataKey="label" tick={LABEL} width={96} stroke="var(--color-border-strong)" tickLine={false} />
              <Tooltip
                cursor={{ fill: 'var(--color-surface-2)' }}
                formatter={(v, name) => [formatDurationMs(Number(v)), String(name)]}
                contentStyle={{
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 12, color: 'var(--color-muted)' }} />
              <Bar dataKey="p50" name="p50 (medyan)" fill="var(--color-muted)" radius={[0, 3, 3, 0]} isAnimationActive={false} />
              <Bar dataKey="p95" name="p95" fill="var(--color-text)" radius={[0, 3, 3, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-xs text-muted">
          <tr>
            <th scope="col" className="py-1.5 pr-2 font-medium">
              <span className="sr-only">Grup</span>
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right font-medium">p50</th>
            <th scope="col" className="py-1.5 pr-2 text-right font-medium">p95</th>
            <th scope="col" className="py-1.5 text-right font-medium">Ölçüm</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-border">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal">{g.label}</th>
              <td className="num py-1.5 pr-2 text-right">{fmt(g.pct.p50)}</td>
              <td className="num py-1.5 pr-2 text-right">{fmt(g.pct.p95)}</td>
              <td className="num py-1.5 text-right text-muted">{formatCount(g.pct.n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
