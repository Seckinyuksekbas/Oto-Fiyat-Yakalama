'use client';
import { useId, useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { parseSettingValue, type SettingKey } from '@oto/shared';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { adminErrorMessage, adminFieldErrors } from '@/lib/admin-api';
import type { AdminSetting } from '@/lib/admin-ops-api';
import { useAdminSettings, usePatchSetting } from '@/lib/admin-ops-queries';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * Sistem ayarları (SUPER_ADMIN). Her anahtar ayrı formdur; kayıt kısmi birleştirmedir (yalnızca değişen alanlar gider,
 * `null` alanı varsayılana döndürür). Alan açıklamaları `docs/analysis-engine.md` ve alarm izleyicisinden.
 *
 * Kayıtlı değer geçersizse (ör. eski sürümden kalan çelişkili alanlar) motor varsayılanları kullanır ve API ilgisiz bir
 * yamayı bile 400 ile reddeder. Bu durumda form uyarı gösterir, kayıtlı ham değeri alanlara yazar, hatalı alanları
 * işaretler; yönetici alanı düzeltir ya da "varsayılana dön" ile `null` gönderir.
 */

type FieldKind = 'int' | 'ratio' | 'decimal';
interface FieldMeta {
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
  min: number;
  max: number;
}

const ANALYSIS_FIELDS: FieldMeta[] = [
  { key: 'minComparables', label: 'En az emsal', kind: 'int', min: 2, max: 50,
    description: 'Bir seviyede tahmin için uç değer ayıklamasından sonra gereken en az emsal. Hiçbir seviyede bu sayıya ulaşılmazsa sonuç "yetersiz" (INSUFFICIENT) olur.' },
  { key: 'yearAdjPct', label: 'Yıl düzeltmesi', kind: 'ratio', min: 0, max: 0.3,
    description: 'Emsal fiyatı hedefle arasındaki her yıl farkı için bu oranla bileşik olarak düzeltilir.' },
  { key: 'kmAdjPer10k', label: 'Km düzeltmesi (10.000 km başına)', kind: 'ratio', min: 0, max: 0.2,
    description: 'Havuz Theil–Sen için küçükse kullanılan sabit km düzeltmesi.' },
  { key: 'maxAdjPct', label: 'En fazla toplam düzeltme', kind: 'ratio', min: 0, max: 0.5,
    description: 'Yıl ve km düzeltmesinin toplamı emsalin kendi fiyatının bu oranıyla sınırlanır (0,2 = %80–%120).' },
  { key: 'theilSenMinPool', label: 'Theil–Sen için en az havuz', kind: 'int', min: 3, max: 200,
    description: 'Havuz en az bu büyüklükteyse km eğimi Theil–Sen ile hesaplanır (yalnızca negatifse kullanılır). En az emsal sayısından küçük olamaz.' },
  { key: 'smallPoolMax', label: 'Küçük havuz sınırı', kind: 'int', min: 0, max: 50,
    description: 'Kullanılan emsal sayısı bu değer ya da altındaysa güven en fazla orta (MEDIUM) olur. En az emsal sayısından küçük olamaz.' },
  { key: 'dispersionThreshold', label: 'Yayılım eşiği', kind: 'decimal', min: 0, max: 2,
    description: 'IQR / medyan bu değeri aşarsa güven bir kademe düşer (yüksek yayılım).' },
  { key: 'suspiciousDiscount', label: 'Şüpheli indirim eşiği', kind: 'ratio', min: 0, max: 1,
    description: 'İndirim bu oranı aşarsa güven en fazla düşük (LOW) olur ve puan 50 ile sınırlanır; gerçek dışı fiyatları fırsat saymamak için.' },
  { key: 'poolWindowDays', label: 'Havuz penceresi (gün)', kind: 'int', min: 7, max: 365,
    description: 'Emsal havuzuna son kaç günde görülen (ya da kaldırılan) ilanlar girer.' },
  { key: 'refreshMinChangePct', label: 'Yenileme eşiği', kind: 'ratio', min: 0, max: 1,
    description: 'Yenilemede tahmin bu oranın altında değiştiyse (güven ve motor sürümü de aynıysa) yeni analiz satırı yazılmaz.' },
];

const ALERT_FIELDS: FieldMeta[] = [
  { key: 'notifyQueueDepth', label: 'Bildirim kuyruğu derinliği', kind: 'int', min: 1, max: 1_000_000,
    description: 'Bildirim ve Telegram kuyruklarında bekleyen iş sayısı bunu aşarsa alarm verilir.' },
  { key: 'notifyFailureRate', label: 'Bildirim hata oranı', kind: 'ratio', min: 0, max: 1,
    description: 'Son 1 saatte başarısız / (gönderilen + başarısız) bildirim oranı bunu aşarsa alarm verilir.' },
  { key: 'parserErrorRate', label: 'Ayrıştırma hata oranı', kind: 'ratio', min: 0, max: 1,
    description: 'Bir kaynağın taramasında ayrıştırma hatası / taranan sayfa oranı bunu aşarsa alarm verilir.' },
  { key: 'heartbeatMissSec', label: 'Worker sessizlik süresi (sn)', kind: 'int', min: 10, max: 3600,
    description: 'Daha önce görülen bir worker bu kadar saniye sinyal göndermezse kayıp sayılır ve alarm verilir.' },
];

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 6 });
const pctFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });

/** Sayı → alan metni ("0,07"); binlik ayraç yok ki yeniden ayrıştırılabilsin. */
const toText = (v: unknown): string => (typeof v === 'number' ? String(v).replace('.', ',') : v === undefined || v === null ? '' : String(v));
const show = (v: unknown, kind: FieldKind): string =>
  typeof v === 'number' ? (kind === 'ratio' ? `${nf.format(v)} (%${pctFmt.format(v * 100)})` : nf.format(v)) : String(v);

function parseNum(raw: string, kind: FieldKind): number | null {
  const t = raw.trim().replace(',', '.');
  if (kind === 'int') return /^\d+$/.test(t) ? Number(t) : null;
  return /^\d+(\.\d+)?$/.test(t) || /^\.\d+$/.test(t) ? Number(t) : null;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Doğrulama sorunlarını Türkçe alan mesajlarına çevirir (çapraz kurallar dahil). */
function issueMessages(key: SettingKey, value: Record<string, unknown>, fields: FieldMeta[]): Record<string, string> {
  const r = parseSettingValue(key, value);
  if (r.ok) return {};
  const out: Record<string, string> = {};
  for (const i of r.issues) {
    const k = String(i.path[0] ?? '');
    const f = fields.find((x) => x.key === k);
    if (!f || out[k]) continue;
    const v = value[k];
    if ((k === 'smallPoolMax' || k === 'theilSenMinPool') && typeof v === 'number' && v >= f.min && v <= f.max) {
      out[k] = 'Bu değer en az emsal sayısından küçük olamaz.';
    } else if (typeof v !== 'number') {
      out[k] = 'Kayıtlı değer sayı değil.';
    } else {
      out[k] = rangeMessage(f);
    }
  }
  return out;
}

const rangeMessage = (f: FieldMeta) =>
  `${nf.format(f.min)} ile ${nf.format(f.max)} arasında ${f.kind === 'int' ? 'bir tam sayı' : 'bir değer'} girin.`;

function SettingForm({ setting, fields, title, intro, saveLabel, savedText }: {
  setting: AdminSetting;
  fields: FieldMeta[];
  title: string;
  intro: string;
  saveLabel: string;
  savedText: string;
}) {
  const fid = useId();
  const patch = usePatchSetting();
  const stored: Record<string, unknown> = {};
  if (isPlain(setting.value)) for (const f of fields) if (f.key in setting.value) stored[f.key] = setting.value[f.key];
  const storedIssues = issueMessages(setting.key, stored, fields);
  const invalid = Object.keys(storedIssues).length > 0;
  const baseline = (k: string): unknown => (k in stored ? stored[k] : setting.effective[k]);

  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, toText(baseline(f.key))])));
  const [resets, setResets] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>(storedIssues);
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const edit = (k: string, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setResets((r) => {
      if (!r.has(k)) return r;
      const n = new Set(r);
      n.delete(k);
      return n;
    });
    setNote(null);
  };

  const resetField = (f: FieldMeta) => {
    setResets((r) => new Set(r).add(f.key));
    setDraft((d) => ({ ...d, [f.key]: toText(setting.defaults[f.key]) }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== f.key)));
    setNote(null);
  };

  const submit = async () => {
    if (patch.isPending) return;
    setFormError(null);
    setNote(null);
    const errs: Record<string, string> = {};
    const value: Record<string, number | null> = {};
    for (const f of fields) {
      if (resets.has(f.key)) {
        value[f.key] = null;
        continue;
      }
      const n = parseNum(draft[f.key] ?? '', f.kind);
      if (n === null || n < f.min || n > f.max) {
        errs[f.key] = rangeMessage(f);
        continue;
      }
      if (n !== baseline(f.key)) value[f.key] = n;
    }
    if (Object.keys(errs).length === 0) {
      // Sunucuyla aynı kural: kayıtlı değer + yama birleşimi doğrulanır (çapraz alanlar dahil).
      const merged: Record<string, unknown> = { ...stored };
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      Object.assign(errs, issueMessages(setting.key, merged, fields));
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    if (Object.keys(value).length === 0) {
      setNote('Değişiklik yok; kaydedilecek bir şey bulunmadı.');
      return;
    }
    try {
      await patch.mutateAsync({ key: setting.key, value });
      toast.success(savedText);
    } catch (err) {
      const raw = adminFieldErrors(err);
      const mapped: Record<string, string> = {};
      let unmapped = Object.keys(raw).length === 0;
      for (const [path, msg] of Object.entries(raw)) {
        const k = path.replace(/^value\.?/, '');
        if (fields.some((f) => f.key === k)) mapped[k] = msg;
        else unmapped = true;
      }
      setErrors(mapped);
      if (unmapped) setFormError(adminErrorMessage(err));
    }
  };

  const customized = Object.keys(stored).length;
  const errId = (k: string) => `${fid}-${k}-err`;

  return (
    <form
      aria-labelledby={`${fid}-title`}
      noValidate
      className="flex flex-col rounded-lg border border-border bg-surface"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header className="flex flex-col gap-1 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={`${fid}-title`} className="font-display text-base font-semibold">
            {title}
          </h2>
          <span className="text-[13px] text-muted">
            {customized === 0 ? 'Tümü varsayılan' : `${customized} alan özelleştirildi`}
            {setting.updatedAt ? (
              <>
                , son değişiklik{' '}
                <time dateTime={setting.updatedAt} title={formatDateTime(setting.updatedAt)}>
                  {formatRelative(setting.updatedAt)}
                </time>
              </>
            ) : null}
          </span>
        </div>
        <p className="max-w-[72ch] text-[13px] text-muted">{intro}</p>
      </header>

      {invalid ? (
        <div role="alert" className="mx-5 mt-4 flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning-text">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Kayıtlı değer geçersiz: motor şu anda bu bölümde varsayılanları kullanıyor ve her kayıt reddedilir. İşaretli alanları
            düzeltin ya da varsayılana döndürüp kaydedin.
          </p>
        </div>
      ) : null}

      <fieldset disabled={patch.isPending} className="flex flex-col">
        <legend className="sr-only">{title}</legend>
        {fields.map((f) => {
          const overridden = f.key in stored && !resets.has(f.key);
          const pending = resets.has(f.key);
          const n = parseNum(draft[f.key] ?? '', f.kind);
          return (
            <div
              key={f.key}
              className="grid gap-x-8 gap-y-3 border-t border-border px-5 py-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_15rem]"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`${fid}-${f.key}`} className="text-sm font-medium">
                  {f.label}
                </label>
                <p id={`${fid}-${f.key}-desc`} className="max-w-[60ch] text-[13px] leading-relaxed text-muted">
                  {f.description}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    id={`${fid}-${f.key}`}
                    inputMode={f.kind === 'int' ? 'numeric' : 'decimal'}
                    autoComplete="off"
                    className={cn('num h-9', overridden && 'border-accent/70')}
                    value={draft[f.key] ?? ''}
                    onChange={(e) => edit(f.key, e.target.value)}
                    aria-invalid={errors[f.key] ? true : undefined}
                    aria-describedby={[errors[f.key] ? errId(f.key) : null, `${fid}-${f.key}-desc`, `${fid}-${f.key}-def`].filter(Boolean).join(' ')}
                  />
                  {f.kind === 'ratio' && n !== null ? (
                    <span aria-hidden className="num w-14 shrink-0 text-right text-[13px] text-muted">
                      %{pctFmt.format(n * 100)}
                    </span>
                  ) : null}
                </div>
                {errors[f.key] ? (
                  <p id={errId(f.key)} className="text-[13px] text-danger-text">
                    {errors[f.key]}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[13px]">
                  <span id={`${fid}-${f.key}-def`} className="text-muted">
                    Varsayılan <span className="num text-text">{show(setting.defaults[f.key], f.kind)}</span>
                  </span>
                  {overridden ? (
                    <button
                      type="button"
                      aria-label={`${f.label}: varsayılana dön`}
                      onClick={() => resetField(f)}
                      className="inline-flex items-center gap-1 rounded-sm text-muted underline-offset-4 hover:text-text hover:underline"
                    >
                      <RotateCcw aria-hidden className="size-3" />
                      Varsayılana dön
                    </button>
                  ) : pending ? (
                    <span className="text-warning-text">Kaydedince varsayılana döner</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </fieldset>

      <footer className="flex flex-col gap-3 border-t border-border px-5 py-4">
        {formError ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted" aria-live="polite">
            {note ?? 'Kaydedilen değer worker’lara birkaç saniye içinde ulaşır.'}
          </p>
          <Button type="submit" disabled={patch.isPending} aria-busy={patch.isPending || undefined}>
            {patch.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {saveLabel}
          </Button>
        </div>
      </footer>
    </form>
  );
}

/** Ayar değiştikçe form yeniden kurulur (taslak sunucudaki son değerden başlar). */
const formKey = (s: AdminSetting) => `${s.key}:${s.updatedAt ?? 'none'}:${JSON.stringify(s.value)}`;

export function SettingsView() {
  const q = useAdminSettings();
  if (q.isPending) {
    return (
      <div aria-busy="true" className="flex flex-col gap-6">
        <Skeleton className="h-[480px] rounded-lg" />
        <Skeleton className="h-[260px] rounded-lg" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Ayarlar yüklenemedi"
        description="Bağlantınızı kontrol edip yeniden deneyin."
        action={
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Yeniden dene
          </Button>
        }
      />
    );
  }
  const analysis = q.data.items.find((s) => s.key === 'analysis.settings');
  const alerts = q.data.items.find((s) => s.key === 'alerts.thresholds');
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Ayarlar</h1>
      {analysis ? (
        <SettingForm
          key={formKey(analysis)}
          setting={analysis}
          fields={ANALYSIS_FIELDS}
          title="Analiz katsayıları"
          intro="Fırsat analiz motorunun (rules-v1) katsayıları. Değişiklik yeni analizlerde geçerli olur; mevcut analizler gece yenilemesinde güncellenir."
          saveLabel="Analiz katsayılarını kaydet"
          savedText="Analiz katsayıları kaydedildi"
        />
      ) : null}
      {alerts ? (
        <SettingForm
          key={formKey(alerts)}
          setting={alerts}
          fields={ALERT_FIELDS}
          title="Alarm eşikleri"
          intro="İzleyici her zamanlayıcı turunda bu eşikleri denetler; aynı alarm 30 dakikada bir kez verilir."
          saveLabel="Alarm eşiklerini kaydet"
          savedText="Alarm eşikleri kaydedildi"
        />
      ) : null}
    </div>
  );
}
