'use client';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ListingDetail } from '@oto/shared';
import { formatShortTl, formatTl } from '@/lib/format';

const AXIS = { fontFamily: 'var(--font-mono)', fontSize: 11, fill: 'var(--color-muted)' } as const;

const tickFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: 'short', year: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: 'long', year: 'numeric' });

/** Adım çizgisi: fiyat bir sonraki gözleme kadar sabit kalır; son fiyat son görülme anına uzatılır. */
export function PriceHistoryChart({ history, lastSeenAt }: { history: ListingDetail['priceHistory']; lastSeenAt?: string }) {
  const data = history
    .map((h) => ({ t: new Date(h.observedAt).getTime(), price: Number(h.price) }))
    .filter((d) => Number.isFinite(d.price) && Number.isFinite(d.t))
    .sort((a, b) => a.t - b.t);

  if (data.length === 0) return <p className="text-sm text-muted">Henüz fiyat gözlemi yok.</p>;
  if (data.length === 1) {
    return (
      <p className="text-sm text-muted">
        Fiyat bugüne kadar değişmedi: <span className="num text-text">{formatTl(data[0].price)}</span>
      </p>
    );
  }
  const first = data[0].price;
  const last = data[data.length - 1].price;
  const seen = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  const series = Number.isFinite(seen) && seen > data[data.length - 1].t ? [...data, { t: seen, price: last }] : data;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const change = last - first;
  const summary = `${data.length} fiyat gözlemi. En düşük ${formatTl(min)}, en yüksek ${formatTl(max)}. İlk fiyattan son fiyata değişim: ${change === 0 ? 'yok' : `${change > 0 ? '+' : '-'}${formatTl(Math.abs(change))}`}.`;

  return (
    <figure className="m-0">
      <figcaption className="sr-only">{`Fiyat geçmişi. ${summary}`}</figcaption>
      <div aria-hidden className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => tickFmt.format(new Date(t))}
              tick={AXIS}
              stroke="var(--color-border-strong)"
              tickLine={false}
            />
            <YAxis
              domain={[
                (dataMin: number) => dataMin - Math.max((max - min) * 0.15, dataMin * 0.01),
                (dataMax: number) => dataMax + Math.max((max - min) * 0.15, dataMax * 0.01),
              ]}
              tickFormatter={(v: number) => formatShortTl(v)}
              tick={AXIS}
              stroke="var(--color-border-strong)"
              tickLine={false}
              width={64}
            />
            <Tooltip
              formatter={(v) => [formatTl(Number(v)), 'Fiyat']}
              labelFormatter={(t) => fullFmt.format(new Date(Number(t)))}
              contentStyle={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            />
            <Line type="stepAfter" dataKey="price" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
