import type { AnalysisSummary } from '@oto/shared';
import { cn } from '@/lib/cn';
import { bandGeometry, formatShortTl, formatTl, INSUFFICIENT_REASON_LABEL } from '@/lib/format';

export interface PriceBandProps {
  band: AnalysisSummary['band'];
  /** İlan fiyatı (rakam dizgisi). */
  price: string;
  confidence: AnalysisSummary['confidence'];
  insufficientReason: AnalysisSummary['insufficientReason'];
  size?: 'sm' | 'lg';
  className?: string;
}

const toNum = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Etiket merkezde konumlanır; kapsayıcı kenarlarına piksel olarak yaklaşamaz (CSS clamp). */
const LABEL_HALF = 54;
const labelLeft = (p: number) => `clamp(${LABEL_HALF}px, ${p}%, calc(100% - ${LABEL_HALF}px))`;

/**
 * Fiyat bandı: emsallerin alt–üst çeyrek aralığı (dolu bölge), medyan çizgisi ve ilan fiyatı işaretçisi.
 * Cetvel çentikleri eksenin ölçekli olduğunu hissettirir; işaretçi renge ek olarak metinle de etiketlenir.
 */
export function PriceBand({ band, price, confidence, insufficientReason, size = 'sm', className }: PriceBandProps) {
  const priceN = Number(price);
  const q1 = toNum(band.q1);
  const q3 = toNum(band.q3);
  const median = toNum(band.median);
  const geo = confidence === 'INSUFFICIENT' ? null : bandGeometry({ q1, median, q3, price: priceN });

  if (!geo || q1 === null || q3 === null) {
    const reason = !Number.isFinite(priceN)
      ? 'geçersiz fiyat'
      : (INSUFFICIENT_REASON_LABEL[insufficientReason] ?? INSUFFICIENT_REASON_LABEL.NONE);
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-dashed border-border-strong px-3 text-muted',
          size === 'lg' ? 'min-h-14 text-sm' : 'min-h-10 text-xs',
          className,
        )}
      >
        <span aria-hidden className="inline-block h-px w-5 bg-border-strong" />
        <span>{`Zayıf tahmin — ${reason}`}</span>
      </div>
    );
  }

  const lg = size === 'lg';
  const trackTop = lg ? 26 : 20;
  const trackH = lg ? 12 : 8;
  const pQ1 = geo.pos(q1);
  const pQ3 = geo.pos(q3);
  const pMed = median !== null ? geo.pos(median) : null;
  const pPrice = geo.pos(priceN);
  const below = priceN < q1;
  const above = priceN > q3;
  const markerTone = below ? 'text-positive-text' : above ? 'text-danger-text' : 'text-text';

  const position = below ? 'bandın altında' : above ? 'bandın üstünde' : 'bandın içinde';
  const label = [
    `Fiyat bandı: ilan ${formatTl(price)} (${position})`,
    median !== null ? `medyan ${formatTl(median)}` : null,
    `alt çeyrek ${formatTl(q1)}`,
    `üst çeyrek ${formatTl(q3)}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className={cn('w-full', className)}>
      <div
        role="img"
        aria-label={label}
        className="relative w-full"
        style={{ height: trackTop + trackH + (lg ? 34 : 28) }}
      >
        {pMed !== null && median !== null && (
          <span
            className="tnum absolute top-0 whitespace-nowrap text-[11px] leading-none text-muted"
            style={{ left: labelLeft(pMed), transform: 'translateX(-50%)' }}
          >
            {`medyan ${formatShortTl(median)}`}
          </span>
        )}

        {/* eksen: cetvel çentikleri */}
        <span
          className="absolute inset-x-0 rounded-full border border-border bg-surface-2"
          style={{
            top: trackTop,
            height: trackH,
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0, transparent calc(10% - 1px), color-mix(in oklab, var(--color-border-strong) 55%, transparent) calc(10% - 1px), color-mix(in oklab, var(--color-border-strong) 55%, transparent) 10%)',
          }}
        />
        {/* Q1–Q3 dolu bölge */}
        <span
          className="absolute rounded-full"
          style={{
            top: trackTop,
            height: trackH,
            left: `${pQ1}%`,
            width: `${Math.max(pQ3 - pQ1, 1.5)}%`,
            opacity: confidence === 'LOW' ? 0.55 : 1,
            background:
              'linear-gradient(90deg, color-mix(in oklab, var(--color-accent) 55%, transparent), var(--color-accent) 50%, color-mix(in oklab, var(--color-accent) 55%, transparent))',
          }}
        />
        {/* medyan çizgisi */}
        {pMed !== null && (
          <span
            className="absolute w-[2px] rounded-full bg-text"
            style={{ left: `${pMed}%`, top: trackTop - 5, height: trackH + 10, transform: 'translateX(-50%)' }}
          />
        )}
        {/* ilan işaretçisi */}
        <svg
          aria-hidden
          viewBox="0 0 12 8"
          className={cn('absolute fill-current', markerTone)}
          style={{ left: `${pPrice}%`, top: trackTop + trackH + 3, width: 12, height: 8, transform: 'translateX(-50%)' }}
        >
          <path d="M6 0 12 8H0z" />
        </svg>
        <span
          className={cn('absolute whitespace-nowrap text-[11px] font-medium leading-none', markerTone)}
          style={{ left: labelLeft(pPrice), top: trackTop + trackH + 14, transform: 'translateX(-50%)' }}
        >
          {geo.markerClamped ? 'bu ilan · bant dışı' : 'bu ilan'}
        </span>
      </div>

      {lg && (
        <dl className="mt-1 grid grid-cols-3 gap-2 text-xs text-muted">
          <div>
            <dt>Alt çeyrek</dt>
            <dd className="num text-sm text-text">{formatTl(q1)}</dd>
          </div>
          <div className="text-center">
            <dt>Medyan</dt>
            <dd className="num text-sm text-text">{median !== null ? formatTl(median) : '—'}</dd>
          </div>
          <div className="text-right">
            <dt>Üst çeyrek</dt>
            <dd className="num text-sm text-text">{formatTl(q3)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
