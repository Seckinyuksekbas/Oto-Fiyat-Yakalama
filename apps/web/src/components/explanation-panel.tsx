import { ExternalLink } from 'lucide-react';
import type { ListingDetail } from '@oto/shared';
import { Badge } from '@/components/ui/badge';
import { INSUFFICIENT_REASON_LABEL, formatKm, formatTl } from '@/lib/format';
import { isHttpUrl } from '@/lib/panel-queries';

const LEVEL_SCOPE: Record<number, string> = {
  0: 'aynı yıl, ±%25 km, aynı donanım',
  1: '±1 yıl, ±%25 km',
  2: '±2 yıl, ±%40 km',
  3: '±3 yıl, ±%60 km',
};

const FLAG_LABEL: Record<string, string> = {
  DAMAGED: 'Hasarlı ilan',
  SUSPICIOUS_LOW: 'Şüpheli derecede düşük fiyat',
  HIGH_DISPERSION: 'Emsal fiyatları dağınık',
};

const CONF_TR: Record<string, string> = {
  HIGH: 'Yüksek',
  MEDIUM: 'Orta',
  LOW: 'Düşük',
  INSUFFICIENT: 'Yetersiz',
};

/** Motorun güven adımı kodlarını (`level-cap:HIGH`, `dispersion:-1` …) okunur Türkçe cümleye çevirir. */
export function describeStep(code: string): string {
  const [kind, arg = ''] = code.split(':');
  switch (kind) {
    case 'level-cap':
      return `Kapsam seviyesi güven tavanını belirledi: ${CONF_TR[arg] ?? arg}`;
    case 'small-pool':
      return `Emsal sayısı az: güven en çok ${CONF_TR[arg] ?? arg}`;
    case 'dispersion':
      return 'Emsal fiyatları birbirinden çok farklı: güven bir kademe düştü';
    case 'damaged':
      return 'İlan hasar kaydı taşıyor: güven bir kademe düştü';
    case 'suspicious':
      return `İndirim şüpheli derecede yüksek: güven en çok ${CONF_TR[arg] ?? arg}`;
    case 'insufficient': {
      const why = INSUFFICIENT_REASON_LABEL[arg as keyof typeof INSUFFICIENT_REASON_LABEL];
      return `Yeterli veri yok${why ? `: ${why}` : ''}`;
    }
    default:
      return code;
  }
}

interface RawComp {
  damaged: boolean;
  outlier: boolean;
}

export interface ParsedExplanation {
  level: number | null;
  insufficientReason: keyof typeof INSUFFICIENT_REASON_LABEL | null;
  targetDamaged: boolean | null;
  /** Sunucunun kırpmadığı, motorun tüm emsal listesi (yoksa null). */
  raw: RawComp[] | null;
  poolUsed: number | null;
  poolOutliers: number | null;
  poolDamagedExcluded: number | null;
  kmMethod: 'THEIL_SEN' | 'DEFAULT' | 'NONE' | null;
  kmSlopePerKm: number | null;
  kmAdjPer10k: number | null;
  steps: string[];
  flags: string[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** `explanation` sunucuda `unknown`; alanlar tek tek ve savunmacı okunur. */
export function parseExplanation(input: unknown): ParsedExplanation {
  const e = obj(input);
  const pool = obj(e.pool);
  const adj = obj(e.adjustments);
  const target = obj(e.target);
  const reason =
    typeof e.insufficientReason === 'string' && e.insufficientReason in INSUFFICIENT_REASON_LABEL
      ? (e.insufficientReason as keyof typeof INSUFFICIENT_REASON_LABEL)
      : null;
  const method = adj.kmMethod === 'THEIL_SEN' || adj.kmMethod === 'DEFAULT' || adj.kmMethod === 'NONE' ? adj.kmMethod : null;
  const raw = Array.isArray(e.comparables)
    ? e.comparables.map((c) => ({ damaged: obj(c).damaged === true, outlier: obj(c).outlier === true }))
    : null;
  return {
    level: isNum(e.level) ? e.level : null,
    insufficientReason: reason,
    targetDamaged: typeof target.damaged === 'boolean' ? target.damaged : null,
    raw,
    poolUsed: isNum(pool.used) ? pool.used : null,
    poolOutliers: Array.isArray(pool.outlierIds) ? pool.outlierIds.length : null,
    poolDamagedExcluded: isNum(pool.damagedExcluded) ? pool.damagedExcluded : null,
    kmMethod: method,
    kmSlopePerKm: isNum(adj.kmSlopePerKm) ? adj.kmSlopePerKm : null,
    kmAdjPer10k: isNum(adj.kmAdjPer10k) ? adj.kmAdjPer10k : null,
    steps: Array.isArray(e.confidenceSteps) ? e.confidenceSteps.filter((s): s is string => typeof s === 'string') : [],
    flags: Array.isArray(e.flags) ? e.flags.filter((s): s is string => typeof s === 'string') : [],
  };
}

const pct = (x: number) => String(Math.round(x * 1000) / 10).replace('.', ',');

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function CompBadges({ c }: { c: ListingDetail['comparables'][number] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {c.outlier && <Badge tone="warning">uç değer</Badge>}
      {c.clamped && <Badge>sınırlandı</Badge>}
      {c.damaged && <Badge tone="danger">hasarlı</Badge>}
      {c.status === 'REMOVED' && <Badge>yayından kalktı</Badge>}
    </span>
  );
}

function CompTitle({ c }: { c: ListingDetail['comparables'][number] }) {
  return isHttpUrl(c.url) ? (
    <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 hover:text-accent">
      <span className="truncate">{c.title}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">(yeni sekmede açılır)</span>
    </a>
  ) : (
    <span className="truncate">{c.title}</span>
  );
}

/** "Fiyat nasıl hesaplandı?": emsal kapsamı, düzeltme yöntemi, güven adımları ve emsal tablosu. */
export function ExplanationPanel({ detail }: { detail: ListingDetail }) {
  const ex = parseExplanation(detail.explanation);
  const comps = detail.comparables;
  const insufficient = detail.analysis?.confidence === 'INSUFFICIENT';

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

  // Sayılar motorun kırpılmamış emsal listesinden gelir (API en çok 30 satır döndürür).
  const source: RawComp[] = ex.raw ?? comps;
  const used = source.filter((c) => !c.outlier);
  const outliers = source.filter((c) => c.outlier);
  const usedCount = ex.raw ? used.length : (ex.poolUsed ?? used.length);
  const outlierCount = ex.raw ? outliers.length : (ex.poolOutliers ?? outliers.length);
  const damagedUsed = used.filter((c) => c.damaged).length;
  const damagedOutliers = outliers.filter((c) => c.damaged).length;
  const anyDamagedComp = source.some((c) => c.damaged);
  // Hasarsız hedefte motor önce yalnızca hasarsız emsallerle dener; hasarlılar listeye hiç girmez.
  const cleanOnly = ex.targetDamaged === false && !anyDamagedComp;
  const total = source.length;
  const truncated = total > comps.length;

  const reason = ex.insufficientReason ?? detail.analysis.insufficientReason ?? null;
  const scope = ex.level !== null ? (LEVEL_SCOPE[ex.level] ?? 'genişletilmiş kapsam') : null;

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
        <Fact label={insufficient ? 'Denenen en geniş kapsam' : 'Emsal kapsamı'}>
          {scope !== null && ex.level !== null ? (
            <>
              <span className="tnum font-medium">{`Seviye ${ex.level}`}</span>
              {` · ${scope}`}
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
          {ex.raw && damagedOutliers > 0 && <span className="text-muted">{` (${damagedOutliers}'i hasarlı)`}</span>}
        </Fact>
        <Fact label="Km düzeltme yöntemi">
          {ex.kmMethod === 'THEIL_SEN'
            ? `Theil–Sen eğimi${ex.kmSlopePerKm !== null ? ` (${formatTl(Math.abs(ex.kmSlopePerKm))}/km)` : ''}`
            : ex.kmMethod === 'DEFAULT'
              ? `Varsayılan (10.000 km başına %${pct(ex.kmAdjPer10k ?? 0.02)})`
              : ex.kmMethod === 'NONE'
                ? 'Uygulanmadı'
                : '—'}
        </Fact>
        {!cleanOnly && (
          <Fact label="Hasarlı emsal (hesaba katılan)">
            <span className="num font-medium">{damagedUsed}</span>
          </Fact>
        )}
        {cleanOnly && ex.poolDamagedExcluded !== null && ex.poolDamagedExcluded > 0 && (
          <Fact label="Hesaba katılmayan hasarlı ilan">
            <span className="num font-medium">{ex.poolDamagedExcluded}</span>
          </Fact>
        )}
      </dl>

      {cleanOnly && (
        <p className="mt-3 text-sm text-muted">Aracınızda hasar kaydı olmadığı için yalnızca hasarsız emsaller kullanıldı.</p>
      )}

      {(ex.steps.length > 0 || ex.flags.length > 0) && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Güven nasıl belirlendi?</h3>
          {ex.steps.length > 0 && (
            <ol className="mt-2 grid gap-1 text-sm text-muted">
              {ex.steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-border-strong" />
                  <span>{describeStep(s)}</span>
                </li>
              ))}
            </ol>
          )}
          {ex.flags.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-muted">
              Bayraklar:
              {ex.flags.map((f) => (
                <Badge key={f} tone="warning">
                  {FLAG_LABEL[f] ?? f}
                </Badge>
              ))}
            </p>
          )}
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-medium">
          {truncated ? `Emsaller (ilk ${comps.length} gösteriliyor, toplam ${total})` : `Emsaller (${comps.length})`}
        </h3>
        {comps.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Gösterilecek emsal yok.</p>
        ) : (
          <>
            <ul className="mt-2 grid gap-2 md:hidden">
              {comps.map((c) => (
                <li
                  key={c.id}
                  data-testid="comparable-card"
                  className={'rounded-md border border-border p-3 text-sm ' + (c.outlier ? 'text-muted' : '')}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <CompTitle c={c} />
                    <CompBadges c={c} />
                  </div>
                  <p className="tnum mt-1 text-xs text-muted">
                    {`${c.year} · ${formatKm(c.km)}${c.city ? ` · ${c.city}` : ''}`}
                  </p>
                  <p className="num mt-1">
                    {formatTl(c.price)}
                    <span className="text-muted">{` → ${formatTl(c.adjusted)} düzeltilmiş`}</span>
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-2 hidden overflow-x-auto rounded-md border border-border md:block">
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
                        <CompTitle c={c} />
                        {c.city && <span className="block text-xs text-muted">{c.city}</span>}
                      </td>
                      <td className="num px-3 py-2 text-right">{c.year}</td>
                      <td className="num px-3 py-2 text-right">{formatKm(c.km)}</td>
                      <td className="num px-3 py-2 text-right">{formatTl(c.price)}</td>
                      <td className="num px-3 py-2 text-right">{formatTl(c.adjusted)}</td>
                      <td className="px-3 py-2">
                        <CompBadges c={c} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
