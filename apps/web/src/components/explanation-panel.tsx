import { ExternalLink } from 'lucide-react';
import type { ListingDetail } from '@oto/shared';
import { Badge } from '@/components/ui/badge';
import { INSUFFICIENT_REASON_LABEL, formatKm, formatTl } from '@/lib/format';

const LEVEL_SCOPE: Record<number, string> = {
  0: 'aynı yıl, ±%25 km, aynı donanım',
  1: '±1 yıl, ±%25 km',
  2: '±2 yıl, ±%40 km',
  3: '±3 yıl, ±%60 km',
};

const FLAG_LABEL: Record<string, string> = {
  DAMAGED: 'Hasarlı ilan: güven bir kademe düşürüldü',
  SUSPICIOUS_LOW: 'Şüpheli derecede düşük fiyat: güven en çok Düşük',
  HIGH_DISPERSION: 'Emsal fiyatları birbirinden çok farklı: güven bir kademe düşürüldü',
};

interface ParsedExplanation {
  level: number | null;
  insufficientReason: keyof typeof INSUFFICIENT_REASON_LABEL | null;
  poolUsed: number | null;
  outlierCount: number | null;
  kmMethod: 'THEIL_SEN' | 'DEFAULT' | 'NONE' | null;
  yearAdjPct: number | null;
  kmAdjPer10k: number | null;
  steps: string[];
  flags: string[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `explanation` sunucuda `unknown`; alanlar tek tek ve savunmacı okunur. */
export function parseExplanation(raw: unknown): ParsedExplanation {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pool = (e.pool && typeof e.pool === 'object' ? e.pool : {}) as Record<string, unknown>;
  const adj = (e.adjustments && typeof e.adjustments === 'object' ? e.adjustments : {}) as Record<string, unknown>;
  const reason = typeof e.insufficientReason === 'string' && e.insufficientReason in INSUFFICIENT_REASON_LABEL
    ? (e.insufficientReason as keyof typeof INSUFFICIENT_REASON_LABEL)
    : null;
  const method = adj.kmMethod === 'THEIL_SEN' || adj.kmMethod === 'DEFAULT' || adj.kmMethod === 'NONE' ? adj.kmMethod : null;
  return {
    level: isNum(e.level) ? e.level : null,
    insufficientReason: reason,
    poolUsed: isNum(pool.used) ? pool.used : null,
    outlierCount: Array.isArray(pool.outlierIds) ? pool.outlierIds.length : null,
    kmMethod: method,
    yearAdjPct: isNum(adj.yearAdjPct) ? adj.yearAdjPct : null,
    kmAdjPer10k: isNum(adj.kmAdjPer10k) ? adj.kmAdjPer10k : null,
    steps: Array.isArray(e.confidenceSteps) ? e.confidenceSteps.filter((s): s is string => typeof s === 'string') : [],
    flags: Array.isArray(e.flags) ? e.flags.filter((s): s is string => typeof s === 'string') : [],
  };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** "Fiyat nasıl hesaplandı?": emsal kapsamı, düzeltme yöntemi, güven adımları ve emsal tablosu. */
export function ExplanationPanel({ detail }: { detail: ListingDetail }) {
  const ex = parseExplanation(detail.explanation);
  const comps = detail.comparables;
  const insufficient = detail.analysis?.confidence === 'INSUFFICIENT';

  // Çift saymayı önlemek için sayılar emsal listesinden türetilir (pool.damagedExcluded kullanılmaz).
  const used = comps.filter((c) => !c.outlier);
  const outliers = comps.filter((c) => c.outlier);
  const usedCount = ex.poolUsed ?? used.length;
  const outlierCount = ex.outlierCount ?? outliers.length;
  const damagedUsed = used.filter((c) => c.damaged).length;
  const damagedExcluded = outliers.filter((c) => c.damaged).length;

  const reason = ex.insufficientReason ?? detail.analysis?.insufficientReason ?? null;

  if (!detail.analysis) {
    return (
      <section aria-labelledby="expl-title" className="rounded-lg border border-border bg-surface p-5">
        <h2 id="expl-title" className="font-display text-lg font-semibold">
          Fiyat nasıl hesaplandı?
        </h2>
        <p className="mt-2 text-sm text-muted">Bu ilan için henüz analiz yapılmadı. Analiz tamamlandığında emsaller burada görünür.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="expl-title" className="rounded-lg border border-border bg-surface p-5">
      <h2 id="expl-title" className="font-display text-lg font-semibold">
        Fiyat nasıl hesaplandı?
      </h2>
      <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-muted">
        Aynı marka, model, yakıt ve vitesteki güncel ilanlar yıl ve km farkına göre düzeltilir; uç değerler ayıklanır ve kalanların medyanı tahmini fiyatı verir.
      </p>

      {insufficient && (
        <p role="note" className="mt-4 rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-2 text-sm">
          <strong className="font-medium">Zayıf tahmin.</strong>{' '}
          {`Sebep: ${INSUFFICIENT_REASON_LABEL[reason ?? 'NONE']}. Bu değer fırsat iddiası değil, yalnızca zayıf bir göstergedir.`}
        </p>
      )}

      <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Emsal kapsamı">
          {ex.level !== null ? (
            <>
              <span className="num font-medium">{`L${ex.level}`}</span>
              {` · ${LEVEL_SCOPE[ex.level] ?? 'genişletilmiş kapsam'}`}
            </>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label="Kullanılan emsal">
          <span className="num font-medium">{usedCount}</span>
        </Fact>
        <Fact label="Uç değer sayısı">
          <span className="num font-medium">{outlierCount}</span>
        </Fact>
        <Fact label="Km düzeltme yöntemi">
          {ex.kmMethod === 'THEIL_SEN'
            ? 'Theil–Sen eğimi'
            : ex.kmMethod === 'DEFAULT'
              ? 'Varsayılan (10.000 km başına %2)'
              : ex.kmMethod === 'NONE'
                ? 'Uygulanmadı'
                : '—'}
        </Fact>
        <Fact label="Hasarlı olup kullanılan">
          <span className="num font-medium">{damagedUsed}</span>
        </Fact>
        <Fact label="Hasarlı olup dışlanan">
          <span className="num font-medium">{damagedExcluded}</span>
        </Fact>
        {ex.yearAdjPct !== null && (
          <Fact label="Yıl düzeltmesi">
            <span className="num">{`yıl başına %${Math.round(ex.yearAdjPct * 100 * 10) / 10}`}</span>
          </Fact>
        )}
      </dl>

      {(ex.steps.length > 0 || ex.flags.length > 0) && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Güven nasıl belirlendi?</h3>
          <ol className="mt-2 grid gap-1 text-sm text-muted">
            {ex.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-border-strong" />
                <span>{s}</span>
              </li>
            ))}
            {ex.flags.map((f) => (
              <li key={f} className="flex gap-2 text-warning-text">
                <span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-current" />
                <span>{FLAG_LABEL[f] ?? f}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-medium">{`Emsaller (${comps.length})`}</h3>
        {comps.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Gösterilecek emsal yok.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <caption className="sr-only">Fiyat tahmininde kullanılan emsal ilanlar</caption>
              <thead className="bg-surface-2 text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">İlan</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Yıl</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Km</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">İlan fiyatı</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Düzeltilmiş fiyat</th>
                  <th scope="col" className="px-3 py-2 font-medium">Durum</th>
                </tr>
              </thead>
              <tbody>
                {comps.map((c) => (
                  <tr key={c.id} data-testid="comparable-row" className={'border-t border-border ' + (c.outlier ? 'text-muted' : '')}>
                    <td className="max-w-[260px] px-3 py-2">
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 hover:text-accent"
                      >
                        <span className="truncate">{c.title}</span>
                        <ExternalLink aria-hidden className="size-3 shrink-0" />
                        <span className="sr-only">(yeni sekmede açılır)</span>
                      </a>
                      {c.city && <span className="block text-xs text-muted">{c.city}</span>}
                    </td>
                    <td className="num px-3 py-2 text-right">{c.year}</td>
                    <td className="num px-3 py-2 text-right">{formatKm(c.km)}</td>
                    <td className="num px-3 py-2 text-right">{formatTl(c.price)}</td>
                    <td className="num px-3 py-2 text-right">{formatTl(c.adjusted)}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {c.outlier && <Badge tone="warning">uç değer</Badge>}
                        {c.clamped && <Badge>sınırlandı</Badge>}
                        {c.damaged && <Badge tone="danger">hasarlı</Badge>}
                        {c.status === 'REMOVED' && <Badge>yayından kalktı</Badge>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
