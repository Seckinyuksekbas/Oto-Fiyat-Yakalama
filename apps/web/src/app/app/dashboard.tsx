'use client';
import Link from 'next/link';
import { Bar, BarChart, Cell, XAxis, YAxis, Tooltip as ChartTooltip } from 'recharts';
import { ResponsiveContainer } from 'recharts';
import { ArrowRight, Radar, SlidersHorizontal } from 'lucide-react';
import type { Dashboard } from '@oto/shared';
import { EmptyState } from '@/components/empty-state';
import { ListingCardView } from '@/components/listing-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboard, useMe } from '@/lib/queries';

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1 bg-surface px-5 py-4">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="truncate font-mono text-[28px] font-medium leading-none tabular-nums tracking-tight">{value}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

const dayFmt = new Intl.DateTimeFormat('tr-TR', { weekday: 'short', timeZone: 'Europe/Istanbul' });
const dayLong = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'Europe/Istanbul' });
const at = (day: string) => new Date(`${day}T12:00:00+03:00`);

function MatchSeries({ series }: { series: Dashboard['series'] }) {
  const data = series.map((s) => ({ ...s, label: dayFmt.format(at(s.day)) }));
  const summary = data.map((d) => `${dayLong.format(at(d.day))}: ${d.matches}`).join('; ');
  const peak = Math.max(...data.map((d) => d.matches), 0);
  return (
    <figure
      role="img"
      aria-label={`7 günlük eşleşme grafiği. ${summary}`}
      className="m-0 h-[168px] w-full min-w-0"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }} barCategoryGap="28%">
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: 'var(--color-border)' }}
            tick={{ fill: 'var(--color-muted)', fontSize: 12 }}
          />
          <YAxis hide domain={[0, Math.max(peak, 1)]} />
          <ChartTooltip
            cursor={{ fill: 'color-mix(in oklab, var(--color-text) 6%, transparent)' }}
            contentStyle={{
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 13,
            }}
            labelStyle={{ color: 'var(--color-muted)' }}
            itemStyle={{ color: 'var(--color-text)' }}
            formatter={(v) => [String(v), 'Eşleşme']}
          />
          <Bar dataKey="matches" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={d.day} fill="var(--color-accent)" fillOpacity={i === data.length - 1 ? 1 : 0.62} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-[92px] w-full rounded-lg" />
      <Skeleton className="h-[220px] w-full rounded-lg" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[180px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function DashboardView() {
  const dash = useDashboard();
  const me = useMe();

  if (dash.isPending) return <DashboardSkeleton />;
  if (dash.isError) {
    return (
      <EmptyState
        title="Dashboard yüklenemedi"
        description="Bağlantınızı kontrol edip yeniden deneyin."
        action={
          <Button variant="secondary" onClick={() => void dash.refetch()}>
            Yeniden dene
          </Button>
        }
      />
    );
  }

  const d = dash.data;
  const weekTotal = d.series.reduce((n, s) => n + s.matches, 0);
  const noProfiles = d.profiles.total === 0;

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-label="Özet"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4"
      >
        <Metric label="Aktif profil" value={`${d.profiles.active}/${d.profiles.max}`} />
        <Metric label="Bugünkü bildirim" value={`${d.notifications.today}/${d.notifications.limit}`} />
        <Metric label="7 günlük eşleşme" value={String(weekTotal)} />
        <Metric label="Plan" value={me.data?.subscription?.planName ?? '—'} />
      </section>

      <section aria-labelledby="seri-baslik" className="rounded-lg border border-border bg-surface p-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="seri-baslik" className="font-display text-base font-semibold">
            Günlük eşleşmeler
          </h2>
          <span className="text-[13px] text-muted">Son 7 gün</span>
        </div>
        <MatchSeries series={d.series} />
      </section>

      <section aria-labelledby="son-baslik" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="son-baslik" className="font-display text-lg font-semibold">
            Son eşleşmeler
          </h2>
          {d.recentMatches.length > 0 ? (
            <Link
              href="/app/eslesmeler"
              className="inline-flex items-center gap-1 rounded-md text-sm text-muted transition-colors hover:text-text"
            >
              Tümünü gör
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          ) : null}
        </div>

        {noProfiles ? (
          <EmptyState
            icon={<SlidersHorizontal className="size-5" />}
            title="Henüz arama profiliniz yok"
            description="Marka, model ve bütçenizi tanımlayın. Piyasanın altındaki ilanlar çıktığında size haber verelim."
            action={
              <Button asChild>
                <Link href="/app/profiller/yeni">İlk arama profilinizi oluşturun</Link>
              </Button>
            }
          />
        ) : d.recentMatches.length === 0 ? (
          <EmptyState
            icon={<Radar className="size-5" />}
            title="Henüz eşleşme yok"
            description="Yeni profiller, oluşturulduktan sonra analiz edilen ilanlarla eşleşir. Mevcut fırsatlar için Fırsatlar sayfasına bakın."
            action={
              <Button asChild variant="secondary">
                <Link href="/app/firsatlar">Fırsatlara bak</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {d.recentMatches.slice(0, 8).map((m) => (
              <ListingCardView key={m.id} card={m.listing} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
