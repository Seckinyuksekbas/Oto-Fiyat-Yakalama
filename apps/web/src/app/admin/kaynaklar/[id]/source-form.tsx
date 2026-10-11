'use client';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ADAPTER_KEYS, adminSourceUpdateSchema, type AdminSourceUpdate } from '@oto/shared';
import { PERMISSION_LABEL } from '@/components/admin/catalog/cells';
import { adminSelectCls } from '@/components/admin/filter-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminErrorMessage, adminFieldErrors } from '@/lib/admin-api';
import type { AdminProxy, AdminSource, PermissionType, SourceKind } from '@/lib/admin/catalog-api';
import { useUpdateSource } from '@/lib/admin/catalog-queries';
import { cn } from '@/lib/cn';

const KIND_LABEL: Record<SourceKind, string> = { HTTP: 'HTTP sayfası', BROWSER: 'Tarayıcı', API: 'API', FEED: 'Akış (feed)' };
const PERMISSION_TYPES: PermissionType[] = ['LICENSED_API', 'PARTNER_FEED', 'TOS_PERMITTED', 'TEST'];

/** API `config.baseUrl` sorgu dizisini `?…` ile maskeleyerek döndürür; maskeli değer asla geri gönderilmez. */
export const MASK_MARK = '?…';
export const MASKED_BASE_URL_ERROR =
  'Adres maskeli (?…) görünüyor. Yapılandırmayı değiştirecekseniz baseUrl alanına tam adresi yeniden yazın; değiştirmeyecekseniz eski haline döndürün.';

interface FormState {
  name: string;
  adapterKey: string;
  kind: SourceKind;
  permissionType: PermissionType;
  permissionNote: string;
  permissionVerified: boolean;
  intervalSec: string;
  maxConcurrency: string;
  minRequestGapMs: string;
  proxyConfigId: string;
  config: string;
}

const prettyConfig = (c: unknown) => JSON.stringify(c ?? {}, null, 2);

function initialState(s: AdminSource): FormState {
  return {
    name: s.name,
    adapterKey: s.adapterKey,
    kind: s.kind,
    permissionType: s.permissionType,
    permissionNote: s.permissionNote,
    permissionVerified: s.permissionVerifiedAt !== null,
    intervalSec: String(s.intervalSec),
    maxConcurrency: String(s.maxConcurrency),
    minRequestGapMs: String(s.minRequestGapMs),
    proxyConfigId: s.proxyConfigId === null ? '' : String(s.proxyConfigId),
    config: prettyConfig(s.config),
  };
}

type Built = { ok: true; body: AdminSourceUpdate } | { ok: false; errors: Record<string, string> };

/**
 * Yalnızca değişen alanlar gönderilir. `config` metni değişmediyse hiç gönderilmez (API PATCH'i alan bazlıdır;
 * gönderilmeyen config korunur). Değiştiyse geçerli JSON nesnesi olmalı ve maskeli `baseUrl` taşımamalıdır.
 */
export function buildSourcePatch(initial: FormState, f: FormState): Built {
  const body: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  if (f.name.trim() !== initial.name) body.name = f.name.trim();
  if (f.adapterKey !== initial.adapterKey) body.adapterKey = f.adapterKey;
  if (f.kind !== initial.kind) body.kind = f.kind;
  if (f.permissionType !== initial.permissionType) body.permissionType = f.permissionType;
  if (f.permissionNote.trim() !== initial.permissionNote) body.permissionNote = f.permissionNote.trim();
  if (f.permissionVerified !== initial.permissionVerified) body.permissionVerified = f.permissionVerified;
  for (const k of ['intervalSec', 'maxConcurrency', 'minRequestGapMs'] as const) {
    if (f[k].trim() === initial[k]) continue;
    const n = Number(f[k]);
    if (f[k].trim() === '' || !Number.isInteger(n)) errors[k] = 'Tam sayı girin.';
    else body[k] = n;
  }
  if (f.proxyConfigId !== initial.proxyConfigId) body.proxyConfigId = f.proxyConfigId === '' ? null : Number(f.proxyConfigId);
  if (f.config.trim() !== initial.config.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.config);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.config = 'Geçerli bir JSON nesnesi girin.';
    else {
      const baseUrl = (parsed as { baseUrl?: unknown }).baseUrl;
      if (typeof baseUrl === 'string' && baseUrl.includes(MASK_MARK)) errors.config = MASKED_BASE_URL_ERROR;
      else body.config = parsed;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const r = adminSourceUpdateSchema.safeParse(body);
  if (!r.success) {
    for (const i of r.error.issues) {
      const key = String(i.path[0] ?? '');
      if (!(key in errors)) errors[key] = i.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, body: r.data };
}

const FIELD_HINT: Record<string, string> = {
  intervalSec: '60 ile 86.400 arası',
  maxConcurrency: '1 ile 8 arası',
  minRequestGapMs: '500 ile 60.000 arası; kaynağa saygılı tarama için alt sınır',
};

function Field({ id, label, error, hint, children, className }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[13px] text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SourceForm({ source, proxies }: { source: AdminSource; proxies: AdminProxy[] }) {
  const uid = useId();
  const fid = (k: string) => `${uid}-${k}`;
  const [initial] = useState(() => initialState(source));
  const [f, setF] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const update = useUpdateSource(source.id);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const adapters = ADAPTER_KEYS.includes(source.adapterKey) ? ADAPTER_KEYS : [source.adapterKey, ...ADAPTER_KEYS];
  const revoking = initial.permissionVerified && !f.permissionVerified;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    setFormError(null);
    const built = buildSourcePatch(initial, f);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    if (Object.keys(built.body).length === 0) {
      toast('Değişiklik yok');
      return;
    }
    try {
      const res = await update.mutateAsync(built.body);
      if (source.isActive && !res.source.isActive && built.body.permissionVerified === false) {
        toast.warning('İzin geri alındı; kaynak devre dışı bırakıldı.');
      } else {
        toast.success('Kaynak kaydedildi');
      }
    } catch (err) {
      const fe = adminFieldErrors(err);
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(fe)) mapped[k.split('.')[0] || 'form'] = v;
      setErrors(mapped);
      setFormError(Object.keys(mapped).length > 0 ? 'Girilen bilgileri kontrol edin.' : adminErrorMessage(err));
    }
  };

  const describedBy = (k: string) => (errors[k] ? `${fid(k)}-error` : FIELD_HINT[k] ? `${fid(k)}-hint` : undefined);

  return (
    <form aria-labelledby={fid('title')} noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id={fid('title')} className="font-display text-base font-semibold">
          Kaynak ayarları
        </h2>
        <p className="text-[13px] text-muted">Kaynak kodu ({source.code}) değiştirilemez. Kaydedilen her değişiklik denetim kaydına yazılır.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={fid('name')} label="Ad" error={errors.name}>
          <Input id={fid('name')} value={f.name} maxLength={100} aria-invalid={!!errors.name} aria-describedby={describedBy('name')} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field id={fid('adapterKey')} label="Adapter" error={errors.adapterKey}>
          <select id={fid('adapterKey')} className={adminSelectCls} value={f.adapterKey} onChange={(e) => set('adapterKey', e.target.value)}>
            {adapters.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <Field id={fid('kind')} label="Tür" error={errors.kind}>
          <select id={fid('kind')} className={adminSelectCls} value={f.kind} onChange={(e) => set('kind', e.target.value as SourceKind)}>
            {(Object.keys(KIND_LABEL) as SourceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={fid('proxyConfigId')} label="Proxy" error={errors.proxyConfigId}>
          <select id={fid('proxyConfigId')} className={adminSelectCls} value={f.proxyConfigId} onChange={(e) => set('proxyConfigId', e.target.value)}>
            <option value="">Proxy yok (doğrudan)</option>
            {proxies.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
                {p.isEnabled ? '' : ' (kapalı)'}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="flex flex-col gap-4 border-t border-border pt-4">
        <legend className="sr-only">İzin</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={fid('permissionType')} label="İzin türü" error={errors.permissionType}>
            <select id={fid('permissionType')} className={adminSelectCls} value={f.permissionType} onChange={(e) => set('permissionType', e.target.value as PermissionType)}>
              {PERMISSION_TYPES.map((p) => (
                <option key={p} value={p}>
                  {PERMISSION_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-col gap-1.5 sm:pt-7">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-accent)]"
                checked={f.permissionVerified}
                onChange={(e) => set('permissionVerified', e.target.checked)}
              />
              İzin doğrulandı
            </label>
            {revoking ? (
              <p className="text-[13px] text-warning-text">Kaydedince izin geri alınır ve kaynak etkinse devre dışı kalır.</p>
            ) : null}
          </div>
        </div>
        <Field id={fid('permissionNote')} label="İzin notu" error={errors.permissionNote} hint="İznin dayanağı: sözleşme, lisans ya da kullanım koşulları maddesi.">
          <textarea
            id={fid('permissionNote')}
            rows={3}
            maxLength={500}
            className="rounded-[var(--radius-md)] border border-border-strong bg-surface px-3 py-2 text-sm"
            value={f.permissionNote}
            aria-describedby={describedBy('permissionNote') ?? `${fid('permissionNote')}-hint`}
            onChange={(e) => set('permissionNote', e.target.value)}
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
        <legend className="sr-only">Tarama hızı</legend>
        <Field id={fid('intervalSec')} label="Tarama aralığı (sn)" error={errors.intervalSec} hint={FIELD_HINT.intervalSec}>
          <Input id={fid('intervalSec')} inputMode="numeric" className="num" value={f.intervalSec} aria-describedby={describedBy('intervalSec')} onChange={(e) => set('intervalSec', e.target.value)} />
        </Field>
        <Field id={fid('maxConcurrency')} label="Eşzamanlı istek" error={errors.maxConcurrency} hint={FIELD_HINT.maxConcurrency}>
          <Input id={fid('maxConcurrency')} inputMode="numeric" className="num" value={f.maxConcurrency} aria-describedby={describedBy('maxConcurrency')} onChange={(e) => set('maxConcurrency', e.target.value)} />
        </Field>
        <Field id={fid('minRequestGapMs')} label="İstekler arası bekleme (ms)" error={errors.minRequestGapMs} hint={FIELD_HINT.minRequestGapMs}>
          <Input id={fid('minRequestGapMs')} inputMode="numeric" className="num" value={f.minRequestGapMs} aria-describedby={describedBy('minRequestGapMs')} onChange={(e) => set('minRequestGapMs', e.target.value)} />
        </Field>
      </fieldset>

      <Field
        id={fid('config')}
        label="Yapılandırma (JSON)"
        error={errors.config}
        hint="baseUrl zorunlu, yalnızca http(s), en fazla 4 KB. Adresin sorgu dizisi güvenlik için gizlenir; dokunmazsanız sunucudaki değer korunur."
        className="border-t border-border pt-4"
      >
        <textarea
          id={fid('config')}
          rows={8}
          spellCheck={false}
          className="num rounded-[var(--radius-md)] border border-border-strong bg-surface-2 px-3 py-2 text-[13px] leading-relaxed"
          value={f.config}
          aria-invalid={!!errors.config}
          aria-describedby={errors.config ? `${fid('config')}-error` : `${fid('config')}-hint`}
          onChange={(e) => set('config', e.target.value)}
        />
      </Field>

      {formError ? (
        <p role="alert" className="text-sm text-danger-text">
          {formError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={update.isPending}>
          Değişiklikleri kaydet
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setF(initial);
            setErrors({});
            setFormError(null);
          }}
        >
          Geri al
        </Button>
      </div>
    </form>
  );
}
