'use client';
import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ERROR_KIND_LABEL } from '@/components/admin/catalog/cells';
import { FilterSelect } from '@/components/admin/filter-select';
import { KpiGrid, KpiTile, formatCount, formatDurationMs } from '@/components/admin/kpi-tile';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminSourceStats, StatsRange } from '@/lib/admin/catalog-api';
import { useAdminSourceStats } from '@/lib/admin/catalog-queries';

const AXIS = { fontFamily: 'var(--font-mono)', fontSize: 11, fill: 'var(--color-muted)' } as const;
const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const dayLabel = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));
const pctFmt = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 1 });

type SeriesKey = 'new' | 'updated' | 'removed';
const SERIES: Array<{ key: SeriesKey; title: string }> = [
  { key: 'new', title: 'Yeni ilan' },
  { key: 'updated', title: 'Güncellenen' },
  { key: 'removed', title: 'Yayından kalkan' },
];

/**
 * Günlük ilan sayıları üç ayrı küçük grafikte (small multiples): tek seri, tek renk, efsane gerekmez;
 * ölçekler farklı olduğundan üst üste bindirilmez. Her grafiğin metin özeti `figcaption`'da.
 */
function DailyBars({ data, k, title }: { data: AdminSourceStats['listingsPerDay']; k: SeriesKey; title: string }) {
  const total = data.reduce((a, d) => a + d[k], 0);
  const peak = data.reduce((m, d) => (d[k] > m[k] ? d : m), data[0]!);
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 bg-surface px-4 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] text-muted">{title}</span>
        <span className="num text-lg font-semibold">{formatCount(total)}</span>
      </div>
      <figcaption className="sr-only">{`${title}: ${data.length} günde toplam ${total}. En yüksek ${dayLabel(peak.day)}, ${peak[k]}.`}</figcaption>
      <div aria-hidden className="h-[120px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="24%">
            <XAxis dataKey="day" tickFormatter={dayLabel} tick={AXIS} stroke="var(--color-border-strong)" tickLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis hide domain={[0, 'dataMax']} />
            <Tooltip
              cursor={{ fill: 'var(--color-surface-2)' }}
              contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: 'var(--color-muted)' }}
              itemStyle={{ color: 'var(--color-text)' }}
              labelFormatter={(d: string) => dayLabel(d)}
              formatter={(v: number) => [formatCount(v), title]}
            />
            <Bar dataKey={k} fill="var(--color-text)" fillOpacity={0.72} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function ErrorKinds({ byKind }: { byKind: Record<string, number> }) {
  const rows = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] ?? 0;
  if (rows.length === 0) return <p className="text-sm text-muted">Bu dönemde tarama hatası yok.</p>;
  return (
    <ul aria-label="Hata türleri" className="flex flex-col gap-2">
      {rows.map(([kind, n]) => (
        <li key={kind} className="grid grid-cols-[9rem_minmax(0,1fr)_3.5rem] items-center gap-3 text-sm">
          <span className="truncate">{ERROR_KIND_LABEL[kind] ?? kind}</span>
          <span aria-hidden className="h-2 rounded-full bg-surface-2">
            <span className="block h-2 rounded-full bg-danger" style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
          </span>
          <span className="num text-right">{formatCount(n)}</span>
        </li>
      ))}
    </ul>
  );
}

export function SourceStats({ id }: { id: number }) {
  const [range, setRange] = useState<StatsRange>('7d');
  const q = useAdminSourceStats(id, range);
  return (
    <section aria-labelledby="istatistik" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="istatistik" className="font-display text-base font-semibold">
          İstatistikler
        </h2>
        <FilterSelect
          label="Dönem"
          allLabel={null}
          value={range}
          onChange={(v) => v && setRange(v as StatsRange)}
          options={[
            { value: '24h', label: 'Son 24 saat' },
            { value: '7d', label: 'Son 7 gün' },
            { value: '30d', label: 'Son 30 gün' },
          ]}
        />
      </div>
      {q.isPending ? (
        <Skeleton className="h-[260px] w-full rounded-lg" />
      ) : q.isError ? (
        <p className="text-sm text-muted">İstatistikler yüklenemedi.</p>
      ) : (
        <>
          <KpiGrid label="Tarama özeti" className="md:grid-cols-4">
            <KpiTile label="İş" value={q.data.jobs.total} hint={`${formatCount(q.data.jobs.succeeded)} başarılı, ${formatCount(q.data.jobs.partial)} kısmi`} />
            <KpiTile label="Başarısız iş" value={q.data.jobs.failed} tone={q.data.jobs.failed > 0 ? 'danger' : 'neutral'} />
            <KpiTile
              label="Hata oranı"
              value={q.data.errorRate}
              format={(n) => pctFmt.format(n)}
              tone={q.data.errorRate >= 0.2 ? 'danger' : q.data.errorRate > 0 ? 'warning' : 'neutral'}
              hint="Başarısız ve kısmi işler"
            />
            <KpiTile label="Ortalama yanıt" value={q.data.avgResponseMs} format={formatDurationMs} unavailableHint="Bu dönemde ölçüm yok" />
          </KpiGrid>
          {q.data.listingsPerDay.length === 0 ? (
            <p className="text-sm text-muted">Bu dönemde tamamlanan tarama yok.</p>
          ) : (
            <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3">
              {SERIES.map((s) => (
                <DailyBars key={s.key} data={q.data.listingsPerDay} k={s.key} title={s.title} />
              ))}
            </div>
          )}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
            <h3 className="text-sm font-medium">Hata türleri</h3>
            <ErrorKinds byKind={q.data.errorsByKind} />
          </div>
        </>
      )}
    </section>
  );
}
