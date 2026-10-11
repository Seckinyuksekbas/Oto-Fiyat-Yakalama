'use client';
import { useId, useState, type ReactNode } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { adminPlanCreateSchema, adminPlanUpdateSchema, type PlanLimits } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminErrorMessage, adminFieldErrors, type AdminPlan } from '@/lib/admin-api';
import { useSavePlan } from '@/lib/admin-ops-queries';
import { cn } from '@/lib/cn';

type Channel = PlanLimits['channels'][number];
const CHANNELS: Array<{ value: Channel; label: string }> = [
  { value: 'IN_APP', label: 'Uygulama içi' },
  { value: 'TELEGRAM', label: 'Telegram' },
  { value: 'EMAIL', label: 'E-posta' },
];
const CHANNEL_ORDER: Channel[] = ['IN_APP', 'TELEGRAM', 'EMAIL'];

const LIMIT_FIELDS = [
  { key: 'maxSearchProfiles', label: 'Arama profili sınırı', hint: 'Aynı anda aktif arama profili. E-postası doğrulanmamış kullanıcı en fazla 1.' },
  { key: 'maxNotificationsPerDay', label: 'Günlük bildirim sınırı', hint: 'İstanbul gününe göre; aşan eşleşmeler "limitte kaldı" olur.' },
  { key: 'opportunitiesDelayHours', label: 'Fırsat gecikmesi (saat)', hint: 'Fırsat listesi bu kadar saat geriden gösterilir. 0 = anlık.' },
] as const;
type LimitKey = (typeof LIMIT_FIELDS)[number]['key'];

const INT_MESSAGE = '0 veya daha büyük bir tam sayı girin';
const FREE = 'FREE';

export interface PlanSaved {
  plan: AdminPlan;
  usersOverProfileLimit: number;
  created: boolean;
}

/**
 * Paket oluşturma/düzenleme formu. Kod yalnızca oluştururken girilir (API değiştirmeye izin vermez). IN_APP her pakette
 * zorunludur: onay kutusu kilitlidir ve gövdeye her zaman eklenir. FREE pasifleştirilemez (API 409); kutu kilitli.
 */
export function PlanForm({ plan, onSaved, onCancel }: { plan?: AdminPlan; onSaved(r: PlanSaved): void; onCancel(): void }) {
  const fid = useId();
  const editing = plan !== undefined;
  const isFree = plan?.code === FREE;
  const save = useSavePlan();

  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan ? String(plan.priceMonthly) : '');
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    maxSearchProfiles: plan ? String(plan.limits.maxSearchProfiles) : '',
    maxNotificationsPerDay: plan ? String(plan.limits.maxNotificationsPerDay) : '',
    opportunitiesDelayHours: plan ? String(plan.limits.opportunitiesDelayHours) : '',
  });
  const [channels, setChannels] = useState<Channel[]>(() =>
    CHANNEL_ORDER.filter((c) => c === 'IN_APP' || (plan?.limits.channels ?? []).includes(c)),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const toggle = (c: Channel) => {
    if (c === 'IN_APP') return;
    setChannels((cur) => CHANNEL_ORDER.filter((x) => x === 'IN_APP' || (x === c ? !cur.includes(c) : cur.includes(x))));
  };

  const int = (raw: string, key: string, errs: Record<string, string>): number => {
    const t = raw.trim();
    if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) {
      errs[key] = INT_MESSAGE;
      return 0;
    }
    return Number(t);
  };

  const build = () => {
    const errs: Record<string, string> = {};
    if (!editing && !/^[A-Z0-9_]{2,20}$/.test(code.trim())) errs.code = '2–20 karakter: büyük harf, rakam ya da alt çizgi';
    if (name.trim() === '') errs.name = 'Paket adı girin';
    const priceMonthly = int(price, 'priceMonthly', errs);
    const lim = {
      maxSearchProfiles: int(limits.maxSearchProfiles, 'limits.maxSearchProfiles', errs),
      maxNotificationsPerDay: int(limits.maxNotificationsPerDay, 'limits.maxNotificationsPerDay', errs),
      channels: CHANNEL_ORDER.filter((c) => c === 'IN_APP' || channels.includes(c)),
      opportunitiesDelayHours: int(limits.opportunitiesDelayHours, 'limits.opportunitiesDelayHours', errs),
    };
    if (Object.keys(errs).length > 0) return { errs };
    const base = { name: name.trim(), priceMonthly, isActive: isFree ? true : isActive, limits: lim };
    const issues = (e: { issues: Array<{ path: Array<string | number>; message: string }> }) => {
      for (const i of e.issues) errs[i.path.join('.')] = i.message;
      return { errs };
    };
    if (editing && plan) {
      const parsed = adminPlanUpdateSchema.safeParse(base);
      if (!parsed.success) return issues(parsed.error);
      return { errs, op: { kind: 'update' as const, id: plan.id, body: parsed.data } };
    }
    const parsed = adminPlanCreateSchema.safeParse({ code: code.trim(), ...base });
    if (!parsed.success) return issues(parsed.error);
    return { errs, op: { kind: 'create' as const, body: parsed.data } };
  };

  const submit = async () => {
    if (save.isPending) return;
    setFormError(null);
    const { errs, op } = build();
    setErrors(errs);
    if (!op) return;
    try {
      const r = await save.mutateAsync(op);
      onSaved({ plan: r.plan, usersOverProfileLimit: r.usersOverProfileLimit, created: !editing });
    } catch (err) {
      const fields = adminFieldErrors(err);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
        if (Object.keys(fields).some((k) => !FIELD_KEYS.has(k))) setFormError(adminErrorMessage(err));
      } else {
        setFormError(adminErrorMessage(err));
      }
    }
  };

  const errId = (k: string) => `${fid}-${k.replace(/\./g, '-')}-err`;
  const hintId = (k: string) => `${fid}-${k.replace(/\./g, '-')}-hint`;
  const fieldError = (k: string): ReactNode =>
    errors[k] ? (
      <p id={errId(k)} className="text-[13px] text-danger-text">
        {errors[k]}
      </p>
    ) : null;
  const a11y = (k: string, hint?: boolean) => ({
    'aria-invalid': errors[k] ? (true as const) : undefined,
    'aria-describedby': errors[k] ? errId(k) : hint ? hintId(k) : undefined,
  });

  return (
    <form
      noValidate
      aria-label={editing ? 'Paket formu' : 'Yeni paket formu'}
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={save.isPending} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fid}-code`} className="text-sm font-medium">
              Paket kodu
            </label>
            <Input
              id={`${fid}-code`}
              value={code}
              disabled={editing}
              maxLength={20}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              {...a11y('code', editing)}
            />
            {fieldError('code') ??
              (editing ? (
                <p id={hintId('code')} className="flex items-center gap-1 text-[13px] text-muted">
                  <Lock aria-hidden className="size-3" /> Değiştirilemez
                </p>
              ) : null)}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fid}-name`} className="text-sm font-medium">
              Ad
            </label>
            <Input id={`${fid}-name`} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} {...a11y('name')} />
            {fieldError('name')}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fid}-price`} className="text-sm font-medium">
              Aylık fiyat (₺)
            </label>
            <Input
              id={`${fid}-price`}
              inputMode="numeric"
              className="num"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              {...a11y('priceMonthly')}
            />
            {fieldError('priceMonthly')}
          </div>
          <div className="flex flex-col justify-end gap-1.5 pb-1">
            <label className={cn('flex items-center gap-2.5 text-sm', isFree ? 'text-muted' : 'cursor-pointer')}>
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-accent)] disabled:opacity-60"
                checked={isFree || isActive}
                disabled={isFree}
                aria-describedby={isFree ? hintId('isActive') : undefined}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              Yeni aboneliklere açık
              {isFree ? <Lock aria-hidden className="size-3.5" /> : null}
            </label>
            {isFree ? (
              <p id={hintId('isActive')} className="text-[13px] text-muted">
                FREE paketi her zaman açıktır; aboneliği olmayan herkes bu paketi kullanır.
              </p>
            ) : (
              <p className="text-[13px] text-muted">Kapalı paket yeni kullanıcıya atanamaz; mevcut abonelikler sürer.</p>
            )}
            {fieldError('isActive')}
          </div>
        </div>

        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
          {LIMIT_FIELDS.map((f) => {
            const k = `limits.${f.key}`;
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <label htmlFor={`${fid}-${f.key}`} className="text-sm font-medium">
                  {f.label}
                </label>
                <Input
                  id={`${fid}-${f.key}`}
                  inputMode="numeric"
                  className="num"
                  value={limits[f.key]}
                  onChange={(e) => setLimits((s) => ({ ...s, [f.key]: e.target.value }))}
                  {...a11y(k, true)}
                />
                {fieldError(k) ?? (
                  <p id={hintId(k)} className="text-[13px] leading-snug text-muted">
                    {f.hint}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <fieldset className="flex flex-col gap-2" aria-describedby={`${fid}-inapp-note`}>
          <legend className="mb-1 text-sm font-medium">Kanallar</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CHANNELS.map((c) => {
              const fixed = c.value === 'IN_APP';
              return (
                <label key={c.value} className={cn('flex items-center gap-2 text-sm', fixed ? 'text-muted' : 'cursor-pointer')}>
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-accent)] disabled:opacity-60"
                    checked={fixed || channels.includes(c.value)}
                    disabled={fixed}
                    onChange={() => toggle(c.value)}
                  />
                  {c.label}
                  {fixed ? <Lock aria-hidden className="size-3.5" /> : null}
                </label>
              );
            })}
          </div>
          <p id={`${fid}-inapp-note`} className="text-[13px] text-muted">
            Uygulama içi bildirim her pakette açıktır, kaldırılamaz.
          </p>
          {fieldError('limits.channels')}
        </fieldset>
      </fieldset>

      {formError ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={save.isPending}>
          Vazgeç
        </Button>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>
          {save.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {editing ? 'Paketi kaydet' : 'Paketi oluştur'}
        </Button>
      </div>
    </form>
  );
}

const FIELD_KEYS = new Set([
  'code',
  'name',
  'priceMonthly',
  'isActive',
  'limits.channels',
  ...LIMIT_FIELDS.map((f) => `limits.${f.key}`),
]);
