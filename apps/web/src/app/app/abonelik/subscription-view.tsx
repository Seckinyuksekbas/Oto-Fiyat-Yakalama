'use client';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { useSubscription } from '@/lib/settings-queries';

interface PlanRow {
  code: 'FREE' | 'PRO' | 'BUSINESS';
  name: string;
  profiles: number;
  perDay: number;
  channels: string[];
}

// packages/db/src/seed-data.ts ile aynı değerler; fiyatlar ödeme entegrasyonuyla gelecek.
const PLANS: PlanRow[] = [
  { code: 'FREE', name: 'Ücretsiz', profiles: 2, perDay: 20, channels: ['Uygulama içi', 'Telegram'] },
  { code: 'PRO', name: 'Pro', profiles: 10, perDay: 200, channels: ['Uygulama içi', 'Telegram', 'E-posta'] },
  { code: 'BUSINESS', name: 'Business', profiles: 50, perDay: 2000, channels: ['Uygulama içi', 'Telegram', 'E-posta'] },
];

const CHANNEL_LABEL: Record<string, string> = { IN_APP: 'Uygulama içi', TELEGRAM: 'Telegram', EMAIL: 'E-posta' };
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Etkin',
  TRIALING: 'Deneme',
  PAST_DUE: 'Ödeme bekliyor',
  CANCELED: 'İptal edildi',
  EXPIRED: 'Süresi doldu',
};

const nf = new Intl.NumberFormat('tr-TR');

function Usage({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const high = pct >= 90;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums">
          {nf.format(used)} / {nf.format(max)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={cn('h-full rounded-full', high ? 'bg-warning' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
      {high ? <p className="text-xs text-warning-text">Limitinize yaklaştınız.</p> : null}
    </div>
  );
}

export function SubscriptionView() {
  const q = useSubscription();

  if (q.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <Card className="p-6 text-sm" role="alert">
        Abonelik bilgisi yüklenemedi.{' '}
        <button className="text-accent underline underline-offset-2" onClick={() => void q.refetch()}>
          Tekrar dene
        </button>
      </Card>
    );
  }

  const s = q.data;
  const fallback = s.status === 'FALLBACK';
  const title = fallback ? 'Ücretsiz plan' : s.planName;

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-5xl space-y-8">
        <Card className="grid gap-6 p-6 md:grid-cols-[1.1fr_1fr] md:p-8">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">Mevcut plan</Badge>
              {!fallback ? <Badge tone="positive">{STATUS_LABEL[s.status] ?? s.status}</Badge> : null}
            </div>
            <h2 className="font-display text-3xl font-semibold tracking-tight">{title}</h2>
            <p className="max-w-[46ch] text-sm leading-relaxed text-muted">
              {fallback
                ? 'Etkin bir aboneliğiniz olmadığı için ücretsiz planın limitleri geçerli.'
                : s.endsAt
                  ? `Bitiş tarihi: ${new Date(s.endsAt).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })}`
                  : 'Aboneliğiniz süresiz olarak etkin.'}
            </p>
            <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Plandaki bildirim kanalları">
              {s.limits.channels.map((c) => (
                <li key={c}>
                  <Badge>{CHANNEL_LABEL[c] ?? c}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-5 self-center">
            <Usage label="Arama profili" used={s.usage.searchProfiles} max={s.limits.maxSearchProfiles} />
            <Usage label="Bugünkü bildirim" used={s.usage.notificationsToday} max={s.limits.maxNotificationsPerDay} />
          </div>
        </Card>

        <section aria-labelledby="plans-h" className="space-y-4">
          <div>
            <h2 id="plans-h" className="font-display text-xl font-semibold">
              Planları karşılaştırın
            </h2>
            <p className="text-sm text-muted">Fiyatlar yakında açıklanacak. Ödeme henüz etkin değil.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {PLANS.map((p) => {
              const current = fallback ? p.code === 'FREE' : p.code === s.planCode;
              return (
                <Card key={p.code} className={cn('flex flex-col gap-5 p-5', current && 'border-accent/60')}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-display text-lg font-semibold">{p.name}</h3>
                    {current ? <Badge tone="accent">Mevcut planınız</Badge> : null}
                  </div>
                  <p className="text-sm text-muted">Fiyat yakında</p>
                  <dl className="space-y-2.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Arama profili</dt>
                      <dd className="font-mono tabular-nums">{nf.format(p.profiles)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted">Günlük bildirim</dt>
                      <dd className="font-mono tabular-nums">{nf.format(p.perDay)}</dd>
                    </div>
                  </dl>
                  <ul className="space-y-1.5 text-sm">
                    {p.channels.map((c) => (
                      <li key={c} className="flex items-center gap-2">
                        <Check aria-hidden className="size-4 text-positive-text" />
                        {c}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto pt-1">
                    {current ? null : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="inline-block w-full">
                            <Button variant="secondary" className="w-full" disabled aria-label={`${p.name} planına yükselt`}>
                              Yükselt
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Ödeme yakında</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      </div>
    </TooltipProvider>
  );
}
