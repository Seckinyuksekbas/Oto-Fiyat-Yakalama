'use client';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { adminSubscriptionSchema, type AdminSubscription, type PlanLimits } from '@oto/shared';
import { adminSelectCls } from '@/components/admin/filter-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminErrorMessage, adminFieldErrors, type AdminPlan, type AdminUserDetail } from '@/lib/admin-api';
import { useAdminSetSubscription } from '@/lib/admin-queries';
import { cn } from '@/lib/cn';

type Channel = PlanLimits['channels'][number];
const CHANNELS: Array<{ value: Channel; label: string }> = [
  { value: 'IN_APP', label: 'Uygulama içi' },
  { value: 'TELEGRAM', label: 'Telegram' },
  { value: 'EMAIL', label: 'E-posta' },
];
const CHANNEL_ORDER: Channel[] = ['IN_APP', 'TELEGRAM', 'EMAIL'];

const NUMERIC_FIELDS = [
  { key: 'maxSearchProfiles', label: 'Arama profili' },
  { key: 'maxNotificationsPerDay', label: 'Günlük bildirim' },
  { key: 'opportunitiesDelayHours', label: 'Fırsat gecikmesi (saat)' },
] as const;
type NumericKey = (typeof NUMERIC_FIELDS)[number]['key'];

const INT_MESSAGE = '0 veya daha büyük bir tam sayı girin';
const EXPIRED_MESSAGE = 'Mevcut bitiş tarihi geçmiş. Yeni bir tarih seçin ya da süresiz için boş bırakın.';

/** "YYYY-MM-DD" (İstanbul günü) ↔ ISO. Bitiş, seçilen günün sonudur. */
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' });
export function isoToIstanbulDay(iso: string | null): string {
  return iso ? dayFmt.format(new Date(iso)) : '';
}
export function istanbulDayToIso(day: string): string {
  return new Date(`${day}T23:59:59+03:00`).toISOString();
}

function sameChannels(a: Channel[], b: Channel[]): boolean {
  return a.length === b.length && a.every((c) => b.includes(c));
}

interface Props {
  userId: string;
  detail: AdminUserDetail;
  plans: AdminPlan[];
  /** Neden düzenlenemiyor (kendi hesabı, süper admin hedefi, silinmiş hesap); null ise düzenlenebilir. */
  lockedReason: string | null;
}

/**
 * Abonelik düzenleme: paket, bitiş tarihi, kullanıcıya özel limit geçersiz kılmaları.
 * - Sayısal alanlar boşsa paket değeri geçerlidir (gönderilmez).
 * - Kanallar paketin kanallarıyla başlar; yalnızca farklıysa gönderilir. IN_APP kilitlidir (API de reddeder).
 * - İstemci doğrulaması `adminSubscriptionSchema` ile; sunucu 400 ayrıntıları alanlara, 409 forma yazılır.
 */
export function SubscriptionForm({ userId, detail, plans, lockedReason }: Props) {
  const formId = useId();
  const current = plans.find((p) => p.code === (detail.subscription?.planCode ?? 'FREE'));
  // Pasif paket seçilemez: önceden seçili gelmez, yeni bir paket seçilmesi gerekir (API `planId` zorunlu, pasife 409).
  const currentInactive = current !== undefined && !current.isActive;
  const initialOverrides = detail.subscription?.limitOverrides ?? null;
  const originalEndsAt = detail.subscription?.endsAt ?? null;
  const initialDay = isoToIstanbulDay(originalEndsAt);
  const originalExpired = originalEndsAt !== null && Date.parse(originalEndsAt) <= Date.now();

  const [planId, setPlanId] = useState(current && current.isActive ? current.id : '');
  const [endsDay, setEndsDay] = useState(initialDay);
  const [overrideOn, setOverrideOn] = useState(initialOverrides !== null && Object.keys(initialOverrides).length > 0);
  const [nums, setNums] = useState<Record<NumericKey, string>>(() => ({
    maxSearchProfiles: initialOverrides?.maxSearchProfiles?.toString() ?? '',
    maxNotificationsPerDay: initialOverrides?.maxNotificationsPerDay?.toString() ?? '',
    opportunitiesDelayHours: initialOverrides?.opportunitiesDelayHours?.toString() ?? '',
  }));
  const [channelOverride, setChannelOverride] = useState<Channel[] | null>(initialOverrides?.channels ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAdminSetSubscription(userId);
  const busy = useRef(false);

  const plan = plans.find((p) => p.id === planId);
  const planChannels = plan?.limits.channels ?? ['IN_APP'];
  const channels = channelOverride ?? planChannels;
  const locked = lockedReason !== null;

  const toggleChannel = (c: Channel) => {
    if (c === 'IN_APP') return;
    const next = channels.includes(c) ? channels.filter((x) => x !== c) : [...channels, c];
    setChannelOverride(CHANNEL_ORDER.filter((x) => next.includes(x)));
  };

  const build = (): { body?: AdminSubscription; errors: Record<string, string> } => {
    const errs: Record<string, string> = {};
    if (!planId) errs.planId = 'Paket seçin';
    let endsAt: string | null = null;
    if (endsDay && endsDay === initialDay) {
      // Gün düzenlenmedi: özgün değer aynen gönderilir (saat/dakika korunur).
      endsAt = originalEndsAt;
      if (originalExpired) errs.endsAt = EXPIRED_MESSAGE;
    } else if (endsDay) {
      endsAt = istanbulDayToIso(endsDay);
      if (Date.parse(endsAt) <= Date.now()) errs.endsAt = 'Bitiş tarihi gelecekte olmalı';
    }
    let limitOverrides: AdminSubscription['limitOverrides'] = null;
    if (overrideOn) {
      const o: NonNullable<AdminSubscription['limitOverrides']> = {};
      for (const f of NUMERIC_FIELDS) {
        const raw = nums[f.key].trim();
        if (raw === '') continue;
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) errs[`limitOverrides.${f.key}`] = INT_MESSAGE;
        else o[f.key] = n;
      }
      if (!sameChannels(channels, planChannels)) o.channels = channels;
      limitOverrides = Object.keys(o).length > 0 ? o : null;
    }
    if (Object.keys(errs).length > 0) return { errors: errs };
    const parsed = adminSubscriptionSchema.safeParse({ planId, endsAt, limitOverrides });
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const key = i.path.join('.');
        errs[key] = key.endsWith('channels') ? 'Uygulama içi kanal kaldırılamaz' : 'Geçersiz değer';
      }
      return { errors: errs };
    }
    return { body: parsed.data, errors: {} };
  };

  const submit = async () => {
    if (locked || busy.current) return;
    setFormError(null);
    const { body, errors: errs } = build();
    setErrors(errs);
    if (!body) return;
    busy.current = true;
    try {
      const res = await save.mutateAsync(body);
      toast.success('Abonelik güncellendi', {
        description:
          res.pausedProfiles > 0
            ? `${res.pausedProfiles} profil duraklatıldı; yeni paketin profil sınırı aşılıyordu. Kullanıcıya bildirim gönderildi.`
            : `Geçerli paket: ${plans.find((p) => p.code === res.planCode)?.name ?? res.planCode}`,
      });
    } catch (err) {
      const fields = adminFieldErrors(err);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
        const unmapped = Object.keys(fields).filter((k) => !FIELD_KEYS.has(k));
        if (unmapped.length > 0) setFormError(adminErrorMessage(err));
      } else {
        setFormError(adminErrorMessage(err));
      }
    } finally {
      busy.current = false;
    }
  };

  const errId = (k: string) => `${formId}-${k.replace(/\./g, '-')}-err`;
  const fieldError = (k: string): ReactNode =>
    errors[k] ? (
      <p id={errId(k)} className="text-[13px] text-danger-text">
        {errors[k]}
      </p>
    ) : null;
  const a11y = (k: string) => ({
    'aria-invalid': errors[k] ? (true as const) : undefined,
    'aria-describedby': errors[k] ? errId(k) : undefined,
  });

  return (
    <form
      aria-label="Abonelik"
      noValidate
      className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-base font-semibold">Abonelik</h2>
        <p className="text-[13px] text-muted">
          Kaydedince önceki abonelik iptal edilir ve yeni paket hemen geçerli olur. Sınırı aşan aktif profiller en yeniden
          başlayarak duraklatılır.
        </p>
      </div>

      {lockedReason ? (
        <p className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
          <Lock aria-hidden className="size-4 shrink-0" />
          {lockedReason}
        </p>
      ) : null}

      <fieldset disabled={locked || save.isPending} className="flex flex-col gap-5 disabled:opacity-80">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-plan`} className="text-sm font-medium">
              Paket
            </label>
            <select
              id={`${formId}-plan`}
              className={cn(adminSelectCls, 'h-10', errors.planId && 'border-danger')}
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              {...a11y('planId')}
            >
              {planId === '' ? <option value="">Paket seçin</option> : null}
              {plans.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.isActive}>
                  {p.isActive ? p.name : `${p.name} (pasif)`}
                </option>
              ))}
            </select>
            {fieldError('planId') ??
              (currentInactive && planId === '' ? (
                <p className="text-[13px] text-warning-text">
                  Mevcut paket ({current?.name}) pasif. Kaydetmek için etkin bir paket seçin.
                </p>
              ) : null)}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-ends`} className="text-sm font-medium">
              Bitiş tarihi
            </label>
            <Input
              id={`${formId}-ends`}
              type="date"
              value={endsDay}
              onChange={(e) => setEndsDay(e.target.value)}
              {...a11y('endsAt')}
              aria-describedby={errors.endsAt ? errId('endsAt') : `${formId}-ends-hint`}
            />
            {fieldError('endsAt') ??
              (originalExpired && endsDay === initialDay ? (
                <p id={`${formId}-ends-hint`} className="text-[13px] text-warning-text">
                  {EXPIRED_MESSAGE}
                </p>
              ) : (
                <p id={`${formId}-ends-hint`} className="text-[13px] text-muted">
                  Boş bırakılırsa süresiz. Seçilen günün sonunda (İstanbul) biter.
                </p>
              ))}
          </div>
        </div>

        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-accent)]"
              checked={overrideOn}
              onChange={(e) => setOverrideOn(e.target.checked)}
            />
            Bu kullanıcıya özel limitler
          </label>

          {overrideOn ? (
            <div className="flex flex-col gap-4 pl-0 sm:pl-6">
              <div className="grid gap-4 sm:grid-cols-3">
                {NUMERIC_FIELDS.map((f) => {
                  const k = `limitOverrides.${f.key}`;
                  return (
                    <div key={f.key} className="flex flex-col gap-1.5">
                      <label htmlFor={`${formId}-${f.key}`} className="text-sm">
                        {f.label}
                      </label>
                      <Input
                        id={`${formId}-${f.key}`}
                        inputMode="numeric"
                        className="num"
                        placeholder={plan ? `Paket: ${plan.limits[f.key]}` : ''}
                        value={nums[f.key]}
                        onChange={(e) => setNums((s) => ({ ...s, [f.key]: e.target.value }))}
                        {...a11y(k)}
                      />
                      {fieldError(k)}
                    </div>
                  );
                })}
              </div>

              <fieldset className="flex flex-col gap-2" aria-describedby={errors['limitOverrides.channels'] ? errId('limitOverrides.channels') : undefined}>
                <legend className="mb-1 text-sm">Kanallar</legend>
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
                          aria-describedby={fixed ? `${formId}-inapp-note` : undefined}
                          onChange={() => toggleChannel(c.value)}
                        />
                        {c.label}
                        {fixed ? <Lock aria-hidden className="size-3.5" /> : null}
                      </label>
                    );
                  })}
                </div>
                <p id={`${formId}-inapp-note`} className="text-[13px] text-muted">
                  Uygulama içi bildirim her pakette açıktır, kapatılamaz.
                </p>
                {fieldError('limitOverrides.channels')}
              </fieldset>
              <p className="text-[13px] text-muted">Boş bırakılan sayılar için paket değeri geçerlidir.</p>
            </div>
          ) : null}
        </div>
      </fieldset>

      {formError ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={locked || save.isPending} aria-busy={save.isPending || undefined}>
          {save.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Aboneliği kaydet
        </Button>
      </div>
    </form>
  );
}

const FIELD_KEYS = new Set([
  'planId',
  'endsAt',
  'limitOverrides.channels',
  ...NUMERIC_FIELDS.map((f) => `limitOverrides.${f.key}`),
]);
