'use client';
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { FUELS, TRANSMISSIONS, type Fuel, type Transmission } from '@oto/shared';
import { ProfilePreview } from '@/components/profile-preview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { FUEL_LABEL, GEAR_LABEL, formatTl } from '@/lib/format';
import { apiErrorMessage } from '@/lib/messages';
import { useCatalogMakes, useCatalogModels } from '@/lib/panel-queries';
import {
  DEFAULT_FORM,
  detailsToFieldErrors,
  diffPayload,
  formToPayload,
  formToPreview,
  limitNotice,
  profileToForm,
  useChannelsInfo,
  useCreateProfile,
  useProfileLimits,
  useUpdateProfile,
  validatePayload,
  type FieldErrors,
  type LimitNotice,
  type ProfileFormState,
  type SearchProfile,
} from '@/lib/profile-queries';

const STEPS = ['Araç', 'Fırsat ölçütü', 'Kanallar'] as const;

const FIELD_STEP: Record<string, number> = {
  make: 0, model: 0, yearMin: 0, yearMax: 0, kmMax: 0, fuels: 0, transmissions: 0, cities: 0,
  minDiscountPct: 1, minConfidence: 1, priceMin: 1, priceMax: 1, excludeDamaged: 1, notifyOnPriceDrop: 1, priceDropPct: 1, notifyOnRelist: 1,
  name: 2, channels: 2,
};

const ANY = '__any';
const CONFIDENCE_OPTIONS = [
  ['LOW', 'Düşük'],
  ['MEDIUM', 'Orta'],
  ['HIGH', 'Yüksek'],
] as const;

const digits = (s: string) => s.replace(/\D/g, '');

/* ---------------------------- küçük parçalar ---------------------------- */

function Field({ label, htmlFor, error, hint, children, className }: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p role="note" className="text-[13px] text-danger-text">{error}</p>
      ) : hint ? (
        <p className="num text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function ChipToggle<T extends string>({ options, labels, value, onChange, ariaLabel }: {
  options: readonly T[];
  labels: Record<string, string>;
  value: T[];
  onChange: (v: T[]) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors',
              on
                ? 'border-accent/60 bg-accent/12 text-accent'
                : 'border-border-strong/70 bg-surface text-muted hover:border-muted hover:text-text',
            )}
          >
            {on && <Check aria-hidden className="size-3.5" />}
            {labels[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

function CityInput({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.some((c) => c.toLocaleLowerCase('tr') === p.toLocaleLowerCase('tr'))) next.push(p);
    onChange(next.slice(0, 20));
    setDraft('');
  };
  return (
    <Field label="Şehirler" htmlFor="pf-city" error={error} hint="Boş bırakırsanız tüm şehirler. Enter ile ekleyin.">
      <div className="flex gap-2">
        <Input
          id="pf-city"
          value={draft}
          placeholder="Örn. İstanbul"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" onClick={add} disabled={!draft.trim()}>
          Ekle
        </Button>
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2 pt-1">
          {value.map((c) => (
            <li key={c} className="inline-flex h-8 items-center gap-1 rounded-full border border-border-strong/70 bg-surface-2 pl-3 pr-1 text-sm">
              {c}
              <button
                type="button"
                aria-label={`${c} şehrini kaldır`}
                onClick={() => onChange(value.filter((x) => x !== c))}
                className="grid size-6 place-items-center rounded-full text-muted hover:bg-border hover:text-text"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

function RadioCard({ checked, onSelect, title, description, name }: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  name: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer flex-col gap-1 rounded-lg border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
        checked ? 'border-accent/70 bg-accent/8' : 'border-border-strong/60 bg-surface hover:border-muted',
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className={cn('grid size-4 place-items-center rounded-full border', checked ? 'border-accent' : 'border-border-strong')}>
          {checked && <span className="size-2 rounded-full bg-accent" />}
        </span>
        {title}
      </span>
      <span className="pl-6 text-[13px] leading-relaxed text-muted">{description}</span>
    </label>
  );
}

function ToggleRow({ id, label, description, checked, onChange, disabled, children }: {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id}>{label}</Label>
          {description ? <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{description}</p> : null}
        </div>
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </div>
      {children}
    </div>
  );
}

/* ------------------------------ adımlar --------------------------------- */

interface StepProps {
  form: ProfileFormState;
  set: (patch: Partial<ProfileFormState>) => void;
  errors: FieldErrors;
}

function VehicleStep({ form, set, errors }: StepProps) {
  const makes = useCatalogMakes();
  const models = useCatalogModels(form.make || undefined);
  const makeOpts = useMemo(() => {
    const list = (makes.data?.items ?? []).map((m) => m.make);
    return form.make && !list.includes(form.make) ? [form.make, ...list] : list;
  }, [makes.data, form.make]);
  const modelOpts = useMemo(() => {
    const list = form.make ? (models.data?.items ?? []).map((m) => m.model) : [];
    return form.model && !list.includes(form.model) ? [form.model, ...list] : list;
  }, [models.data, form.make, form.model]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Marka" htmlFor="pf-make" error={errors.make}>
          <Select value={form.make || ANY} onValueChange={(v) => set({ make: v === ANY ? '' : v, model: '' })}>
            <SelectTrigger id="pf-make" aria-invalid={!!errors.make}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Fark etmez</SelectItem>
              {makeOpts.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Model" htmlFor="pf-model" error={errors.model} hint={!form.make ? 'Önce marka seçin.' : undefined}>
          <Select value={form.model || ANY} onValueChange={(v) => set({ model: v === ANY ? '' : v })} disabled={!form.make}>
            <SelectTrigger id="pf-model" aria-invalid={!!errors.model}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Fark etmez</SelectItem>
              {modelOpts.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="En eski model yılı" htmlFor="pf-year-min" error={errors.yearMin}>
          <Input id="pf-year-min" inputMode="numeric" maxLength={4} placeholder="2015" value={form.yearMin} aria-invalid={!!errors.yearMin}
            onChange={(e) => set({ yearMin: digits(e.target.value) })} className="num" />
        </Field>
        <Field label="En yeni model yılı" htmlFor="pf-year-max" error={errors.yearMax}>
          <Input id="pf-year-max" inputMode="numeric" maxLength={4} placeholder="2024" value={form.yearMax} aria-invalid={!!errors.yearMax}
            onChange={(e) => set({ yearMax: digits(e.target.value) })} className="num" />
        </Field>
        <Field label="Azami km" htmlFor="pf-km" error={errors.kmMax}>
          <Input id="pf-km" inputMode="numeric" maxLength={7} placeholder="150000" value={form.kmMax} aria-invalid={!!errors.kmMax}
            onChange={(e) => set({ kmMax: digits(e.target.value) })} className="num" />
        </Field>
      </div>

      <Field label="Yakıt" error={errors.fuels} hint="Seçmezseniz hepsi.">
        <ChipToggle<Fuel> options={FUELS} labels={FUEL_LABEL} value={form.fuels} onChange={(v) => set({ fuels: v })} ariaLabel="Yakıt türü" />
      </Field>
      <Field label="Vites" error={errors.transmissions} hint="Seçmezseniz hepsi.">
        <ChipToggle<Transmission> options={TRANSMISSIONS} labels={GEAR_LABEL} value={form.transmissions} onChange={(v) => set({ transmissions: v })} ariaLabel="Vites türü" />
      </Field>
      <CityInput value={form.cities} onChange={(v) => set({ cities: v })} error={errors.cities} />
    </div>
  );
}

function CriteriaStep({ form, set, errors }: StepProps) {
  return (
    <div className="flex flex-col gap-6">
      <div role="radiogroup" aria-label="Hangi ilanlar bildirilsin" className="grid gap-3 sm:grid-cols-2">
        <RadioCard
          name="mode"
          checked={form.mode === 'DEALS'}
          onSelect={() => set({ mode: 'DEALS' })}
          title="Yalnızca fırsatlar"
          description="Piyasanın belirli bir oranda altındaki, yeterli emsali olan ilanlar."
        />
        <RadioCard
          name="mode"
          checked={form.mode === 'ALL'}
          onSelect={() => set({ mode: 'ALL' })}
          title="Tüm yeni ilanlar"
          description="Filtrene uyan her yeni ilan, fiyatı ne olursa olsun."
        />
      </div>

      {form.mode === 'DEALS' ? (
        <div className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4">
          <Field label="En az indirim" htmlFor="pf-discount" error={errors.minDiscountPct}>
            <div className="flex items-center gap-4">
              <input
                id="pf-discount"
                type="range"
                min={5}
                max={50}
                step={1}
                value={form.discountPct}
                onChange={(e) => set({ discountPct: Number(e.target.value) })}
                aria-valuetext={`yüzde ${form.discountPct}`}
                className="h-2 flex-1 cursor-pointer accent-[var(--color-accent)]"
              />
              <output htmlFor="pf-discount" className="num w-16 text-right text-lg font-semibold text-accent">%{form.discountPct}</output>
            </div>
          </Field>
          <div className="flex flex-col gap-2">
            <span id="pf-conf-label" className="text-sm font-medium">Minimum güven</span>
            <div role="radiogroup" aria-labelledby="pf-conf-label" className="inline-flex w-fit overflow-hidden rounded-md border border-border-strong">
              {CONFIDENCE_OPTIONS.map(([v, l]) => (
                <label
                  key={v}
                  className={cn(
                    'cursor-pointer px-4 py-2 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent',
                    form.minConfidence === v ? 'bg-accent text-accent-fg' : 'bg-surface text-muted hover:text-text',
                  )}
                >
                  <input type="radio" name="conf" className="sr-only" checked={form.minConfidence === v} onChange={() => set({ minConfidence: v })} />
                  {l}
                </label>
              ))}
            </div>
            {errors.minConfidence && <p className="text-[13px] text-danger-text">{errors.minConfidence}</p>}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-surface p-4 text-[13px] leading-relaxed text-muted">
          Yeni ilan takibinde güven koşulu uygulanmaz: zayıf tahminli ilanlar da dahil, filtrene uyan her yeni ilan bildirilir.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="En düşük fiyat (₺)" htmlFor="pf-price-min" error={errors.priceMin} hint={form.priceMin ? formatTl(digits(form.priceMin) || '0') : undefined}>
          <Input id="pf-price-min" inputMode="numeric" value={form.priceMin} aria-invalid={!!errors.priceMin} className="num"
            onChange={(e) => set({ priceMin: digits(e.target.value) })} />
        </Field>
        <Field label="En yüksek fiyat (₺)" htmlFor="pf-price-max" error={errors.priceMax} hint={form.priceMax ? formatTl(digits(form.priceMax) || '0') : undefined}>
          <Input id="pf-price-max" inputMode="numeric" value={form.priceMax} aria-invalid={!!errors.priceMax} className="num"
            onChange={(e) => set({ priceMax: digits(e.target.value) })} />
        </Field>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
        <ToggleRow id="pf-damaged" label="Hasarlı ilanları hariç tut" description="Analizde hasar işareti olan ilanlar listelenmez."
          checked={form.excludeDamaged} onChange={(v) => set({ excludeDamaged: v })} />
        <ToggleRow id="pf-drop" label="Fiyat düşüşünde haber ver" description="Daha önce bildirilen ilanın fiyatı düşerse yeniden bildirim gelir."
          checked={form.notifyOnPriceDrop} onChange={(v) => set({ notifyOnPriceDrop: v })}>
          {form.notifyOnPriceDrop && (
            <Field label="Düşüş eşiği (%)" htmlFor="pf-drop-pct" error={errors.priceDropPct} className="max-w-[10rem]">
              <Input id="pf-drop-pct" type="number" min={1} max={50} value={form.priceDropPct} aria-invalid={!!errors.priceDropPct} className="num"
                onChange={(e) => set({ priceDropPct: Number(e.target.value) })} />
            </Field>
          )}
        </ToggleRow>
        <ToggleRow id="pf-relist" label="Yeniden yayında haber ver" description="Kaldırılan bir ilan yeniden yayınlanırsa bildirim gelir."
          checked={form.notifyOnRelist} onChange={(v) => set({ notifyOnRelist: v })} />
      </div>
    </div>
  );
}

function ChannelsStep({ form, set, errors }: StepProps) {
  const { limits } = useProfileLimits();
  const channels = useChannelsInfo();
  const tg = channels.data?.items.find((i) => i.type === 'TELEGRAM');
  const linked = !!(tg?.linked ?? tg?.isVerified);

  let reason: ReactNode = null;
  // Plan ve kanal bilgisi gelene kadar seçenek kapalı kalır.
  let allowed = !!limits && !!channels.data;
  if (limits && !limits.telegramInPlan) {
    allowed = false;
    reason = (
      <>Planınız Telegram bildirimlerini içermiyor. <Link href="/app/abonelik" className="text-accent underline underline-offset-2">Planı yükseltin</Link>.</>
    );
  } else if (channels.data && !channels.data.telegramAvailable) {
    allowed = false;
    reason = 'Telegram bildirimleri şu anda kullanılamıyor.';
  } else if (channels.data && !linked) {
    allowed = false;
    reason = (
      <>Telegram hesabınız bağlı değil. <Link href="/app/ayarlar/kanallar" className="text-accent underline underline-offset-2">Ayarlar'dan bağlayın</Link>.</>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Field label="Profil adı" htmlFor="pf-name" error={errors.name}>
        <Input id="pf-name" value={form.name} maxLength={60} aria-invalid={!!errors.name} placeholder="Örn. İstanbul dizel BMW"
          onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
        <ToggleRow id="pf-ch-app" label="Uygulama içi" description="Zil simgesi ve bildirimler sayfası. Her zaman açık." checked disabled />
        <ToggleRow id="pf-ch-tg" label="Telegram" description={reason ?? 'Eşleşmeler Telegram mesajı olarak da gelir.'}
          checked={form.telegram} disabled={!allowed && !form.telegram} onChange={(v) => set({ telegram: v })} />
      </div>
      {errors.channels && <p className="text-[13px] text-danger-text">{errors.channels}</p>}
    </div>
  );
}

/* ------------------------------- ana bileşen ---------------------------- */

export interface ProfileWizardProps {
  /** Verilirse düzenleme modu. */
  profile?: SearchProfile;
}

export function ProfileWizard({ profile }: ProfileWizardProps) {
  const router = useRouter();
  const editing = !!profile;
  const initial = useMemo(() => (profile ? profileToForm(profile) : DEFAULT_FORM), [profile]);
  const [form, setForm] = useState<ProfileFormState>(initial);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<LimitNotice | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const create = useCreateProfile();
  const update = useUpdateProfile(profile?.id ?? '');
  const busy = create.isPending || update.isPending;

  const set = (patch: Partial<ProfileFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      if (Object.keys(e).length === 0) return e;
      const next = { ...e };
      for (const k of Object.keys(patch)) {
        delete next[k];
        if (k === 'mode' || k === 'discountPct') delete next.minDiscountPct;
        if (k === 'telegram') delete next.channels;
      }
      return next;
    });
  };

  const goTo = (n: number) => {
    if (n === 2 && !form.name.trim() && form.make) {
      setForm((f) => ({ ...f, name: `${f.make} ${f.model}`.trim() }));
    }
    setStep(n);
  };

  const preview = useMemo(() => formToPreview(form), [form]);

  const fail = (err: unknown) => {
    setNotice(null);
    setFailure(null);
    if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
      const fe = detailsToFieldErrors(err.details);
      setErrors(fe);
      const first = Object.keys(fe)[0];
      if (first !== undefined && FIELD_STEP[first] !== undefined) setStep(FIELD_STEP[first]);
      setFailure('Girdiğiniz bilgileri kontrol edin.');
      return;
    }
    const ln = limitNotice(err);
    if (ln) {
      setNotice(ln);
      return;
    }
    setFailure(apiErrorMessage(err));
  };

  const submit = () => {
    setNotice(null);
    setFailure(null);
    const payload = formToPayload(form);
    const fe = validatePayload(payload);
    if (Object.keys(fe).length > 0) {
      setErrors(fe);
      const first = Math.min(...Object.keys(fe).map((k) => FIELD_STEP[k] ?? 2));
      setStep(first);
      setFailure('Girdiğiniz bilgileri kontrol edin.');
      return;
    }
    if (profile) {
      const body = diffPayload(payload, formToPayload(profileToForm(profile)));
      if (Object.keys(body).length === 0) {
        toast.info('Değişiklik yok');
        router.push('/app/profiller');
        return;
      }
      update.mutate(body, {
        onSuccess: () => {
          toast.success('Profil güncellendi');
          router.push('/app/profiller');
        },
        onError: fail,
      });
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          toast.success('Profil oluşturuldu');
          router.push('/app/profiller');
        },
        onError: fail,
      });
    }
  };

  const stepProps: StepProps = { form, set, errors };

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link href="/app/profiller" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted hover:text-text">
          <ArrowLeft aria-hidden className="size-4" /> Arama profilleri
        </Link>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{editing ? 'Profili düzenle' : 'Yeni arama profili'}</h1>
        <p className="max-w-[60ch] text-sm text-muted">Ölçütleri belirleyin; sağdaki önizleme her değişiklikte güncellenir.</p>
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (step === STEPS.length - 1) submit();
            else goTo(step + 1);
          }}
          className="flex min-w-0 flex-col gap-6"
        >
          <ol aria-label="Adımlar" className="flex gap-2">
            {STEPS.map((s, i) => (
              <li key={s} className="flex-1">
                <button
                  type="button"
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => goTo(i)}
                  className={cn(
                    'flex w-full flex-col gap-1 border-t-2 pt-2 text-left text-sm transition-colors',
                    i === step ? 'border-accent text-text' : i < step ? 'border-accent/40 text-muted hover:text-text' : 'border-border text-muted hover:text-text',
                  )}
                >
                  <span className="num text-xs text-muted">Adım {i + 1}</span>
                  <span className="font-medium">{s}</span>
                </button>
              </li>
            ))}
          </ol>

          {notice && (
            <div role="alert" className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
              <div className="flex min-w-0 flex-col gap-2">
                <p>{notice.message}</p>
                <Link href={notice.href} className="w-fit font-medium text-accent underline underline-offset-2">{notice.cta}</Link>
                <p className="text-xs text-muted">Girdiğiniz bilgiler korundu.</p>
              </div>
            </div>
          )}
          {failure && !notice && (
            <p role="alert" className="rounded-lg border border-danger/50 bg-danger/10 p-3 text-sm text-danger-text">{failure}</p>
          )}

          <fieldset className="min-w-0 border-0 p-0">
            <legend className="sr-only">{STEPS[step]}</legend>
            {step === 0 && <VehicleStep {...stepProps} />}
            {step === 1 && <CriteriaStep {...stepProps} />}
            {step === 2 && <ChannelsStep {...stepProps} />}
          </fieldset>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>
              <ArrowLeft aria-hidden /> Geri
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="submit">
                Devam <ArrowRight aria-hidden />
              </Button>
            ) : (
              <Button type="submit" disabled={busy}>
                {busy ? 'Kaydediliyor…' : editing ? 'Değişiklikleri kaydet' : 'Profili oluştur'}
              </Button>
            )}
          </div>
        </form>

        <aside className="min-w-0 lg:sticky lg:top-6">
          <ProfilePreview payload={preview} />
        </aside>
      </div>
    </div>
  );
}
