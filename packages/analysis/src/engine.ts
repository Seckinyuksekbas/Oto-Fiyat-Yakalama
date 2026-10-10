import { DEFAULT_SETTINGS, type AnalysisSettings } from './settings';
import { quantile, theilSenSlope } from './stats';
import type { AnalysisExplanation, AnalysisFlag, AnalysisResult, AnalysisTarget, Comparable, Confidence } from './types';

export const ENGINE_VERSION = 'rules-v1';

interface Level {
  level: number;
  yearDelta: number;
  kmPct: number;
  sameTrim: boolean;
  cap: Confidence;
}

export const LEVELS: readonly Level[] = [
  { level: 0, yearDelta: 0, kmPct: 0.25, sameTrim: true, cap: 'HIGH' },
  { level: 1, yearDelta: 1, kmPct: 0.25, sameTrim: false, cap: 'HIGH' },
  { level: 2, yearDelta: 2, kmPct: 0.4, sameTrim: false, cap: 'MEDIUM' },
  { level: 3, yearDelta: 3, kmPct: 0.6, sameTrim: false, cap: 'LOW' },
];

const CONFIDENCE_ORDER: Confidence[] = ['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH'];
const CONFIDENCE_POINTS: Record<Confidence, number> = { HIGH: 30, MEDIUM: 18, LOW: 6, INSUFFICIENT: 0 };
const MAX_DISCOUNT = 0.9999;
const MIN_DISCOUNT = -99.9999;

const atMost = (c: Confidence, cap: Confidence): Confidence =>
  CONFIDENCE_ORDER.indexOf(c) <= CONFIDENCE_ORDER.indexOf(cap) ? c : cap;
const downgrade = (c: Confidence): Confidence => (c === 'HIGH' ? 'MEDIUM' : c === 'MEDIUM' ? 'LOW' : c);
const norm = (s: string | null) => (s ?? '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Aynı başlık + fiyat + km ile tekrar yayınlanan ilanları tek say (en küçük id kalır). */
function dedupe(candidates: Comparable[]): Comparable[] {
  const byKey = new Map<string, Comparable>();
  for (const c of [...candidates].sort((a, b) => a.id - b.id)) {
    const key = `${norm(c.title)}|${c.price}|${c.km}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

function inLevel(t: AnalysisTarget, c: Comparable, l: Level): boolean {
  if (Math.abs(c.year - t.year) > l.yearDelta) return false;
  if (Math.abs(c.km - t.km) > l.kmPct * Math.max(t.km, 10_000)) return false;
  if (l.sameTrim && t.trim && norm(c.trim) !== norm(t.trim)) return false;
  return true;
}

interface Evaluation {
  entries: Array<{ c: Comparable; value: number; clamped: boolean; outlier: boolean }>;
  kept: Array<{ id: number; value: number }>;
  outlierIds: number[];
  kmMethod: 'THEIL_SEN' | 'DEFAULT' | 'NONE';
  slope: number | null;
  q1: number | null;
  med: number | null;
  q3: number | null;
}

/** Bir havuz için yıl + km düzeltmesi, ±maxAdjPct sınırı ve IQR ayıklama. */
function evaluate(target: AnalysisTarget, pool: Comparable[], s: AnalysisSettings): Evaluation {
  const withYear = pool.map((c) => ({
    c,
    original: Number(c.price),
    value: Number(c.price) * (1 + s.yearAdjPct) ** (target.year - c.year),
  }));
  let kmMethod: Evaluation['kmMethod'] = withYear.length === 0 ? 'NONE' : 'DEFAULT';
  let slope: number | null = null;
  if (withYear.length >= s.theilSenMinPool) {
    const fitted = theilSenSlope(withYear.map((p) => ({ x: p.c.km, y: p.value })));
    if (fitted !== null && fitted < 0) {
      slope = fitted;
      kmMethod = 'THEIL_SEN';
    }
  }
  const adjusted = withYear.map((p) => {
    const dKm = target.km - p.c.km;
    const raw = kmMethod === 'THEIL_SEN' ? p.value + (slope as number) * dKm : p.value * (1 - (s.kmAdjPer10k * dKm) / 10_000);
    const value = Math.min(p.original * (1 + s.maxAdjPct), Math.max(p.original * (1 - s.maxAdjPct), raw));
    return { c: p.c, value, clamped: value !== raw };
  });

  let outlierSet = new Set<number>();
  if (adjusted.length >= 4) {
    const sorted = adjusted.map((a) => a.value).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const fence = Math.max(1.5 * (q3 - q1), 0.05 * quantile(sorted, 0.5));
    outlierSet = new Set(adjusted.filter((a) => a.value < q1 - fence || a.value > q3 + fence).map((a) => a.c.id));
  }
  const entries = adjusted.map((a) => ({ ...a, outlier: outlierSet.has(a.c.id) }));
  const kept = entries.filter((e) => !e.outlier).map((e) => ({ id: e.c.id, value: e.value }));
  let q1: number | null = null;
  let med: number | null = null;
  let q3: number | null = null;
  if (kept.length > 0) {
    const sorted = kept.map((k) => k.value).sort((a, b) => a - b);
    q1 = quantile(sorted, 0.25);
    med = quantile(sorted, 0.5);
    q3 = quantile(sorted, 0.75);
  }
  return { entries, kept, outlierIds: [...outlierSet].sort((a, b) => a - b), kmMethod, slope, q1, med, q3 };
}

interface Chosen {
  level: Level;
  inLvl: Comparable[];
  ev: Evaluation;
}

export function analyze(target: AnalysisTarget, candidates: Comparable[], settings: AnalysisSettings = DEFAULT_SETTINGS): AnalysisResult {
  const s = settings;
  const others = candidates.filter((c) => c.id !== target.id);
  const valid = others.filter((c) => c.price > 0n);
  const invalidPrice = others.length - valid.length;
  const base = dedupe(valid);
  const invalidTarget = target.price <= 0n;

  // 1) Kademeli havuz: her seviyede tüm boru hattı; kullanılabilir (IQR sonrası) emsal >= min olan ilk seviye
  const passes = target.damaged ? [false] : [true, false]; // true: yalnızca hasarsız emsaller
  let chosen: Chosen | null = null;
  let last: Chosen | null = null;
  let anyBeforeIqr = false;
  outer: for (const cleanOnly of passes) {
    for (const level of LEVELS) {
      const inLvl = base.filter((c) => inLevel(target, c, level));
      const pool = cleanOnly ? inLvl.filter((c) => !c.damaged) : inLvl;
      const ev = evaluate(target, pool, s);
      if (pool.length >= s.minComparables) anyBeforeIqr = true;
      last = { level, inLvl, ev };
      if (ev.kept.length >= s.minComparables) {
        chosen = last;
        break outer;
      }
    }
  }
  const qualified = chosen !== null && !invalidTarget;
  const pick = chosen ?? (last as Chosen);
  const { ev } = pick;
  const keptIds = new Set(ev.kept.map((k) => k.id));

  // 2) Tahmin
  const estimatedPrice = ev.med === null ? null : BigInt(Math.round(ev.med));
  const priceDiff = estimatedPrice === null || invalidTarget ? null : estimatedPrice - target.price;
  const discountPct =
    estimatedPrice === null || estimatedPrice === 0n || priceDiff === null
      ? null
      : Math.min(MAX_DISCOUNT, Math.max(MIN_DISCOUNT, round4(Number(priceDiff) / Number(estimatedPrice))));
  const dispersion = ev.med !== null && ev.med > 0 && ev.q1 !== null && ev.q3 !== null ? (ev.q3 - ev.q1) / ev.med : null;

  // 3) Güvenilirlik ve bayraklar
  const flags = new Set<AnalysisFlag>();
  const steps: string[] = [];
  const insufficient = !qualified;
  const insufficientReason: AnalysisExplanation['insufficientReason'] = qualified
    ? 'NONE'
    : invalidTarget
      ? 'INVALID_TARGET'
      : anyBeforeIqr
        ? 'AFTER_OUTLIERS'
        : 'NO_LEVEL';
  let confidence: Confidence = insufficient ? 'INSUFFICIENT' : pick.level.cap;
  steps.push(insufficient ? `insufficient:${insufficientReason}` : `level-cap:${pick.level.cap}`);
  if (!insufficient && ev.kept.length <= s.smallPoolMax) {
    confidence = atMost(confidence, 'MEDIUM');
    steps.push('small-pool:MEDIUM');
  }
  if (dispersion !== null && dispersion > s.dispersionThreshold) {
    flags.add('HIGH_DISPERSION');
    if (!insufficient) {
      confidence = downgrade(confidence);
      steps.push('dispersion:-1');
    }
  }
  if (target.damaged) {
    flags.add('DAMAGED');
    if (!insufficient) {
      confidence = downgrade(confidence);
      steps.push('damaged:-1');
    }
  }
  if (discountPct !== null && discountPct > s.suspiciousDiscount) {
    flags.add('SUSPICIOUS_LOW');
    if (!insufficient) {
      confidence = atMost(confidence, 'LOW');
      steps.push('suspicious:LOW');
    }
  }

  // 4) Fırsat puanı
  const discountTerm = discountPct === null ? 0 : Math.min(1, Math.max(0, discountPct / 0.3)) * 70;
  const dropBonus = target.hadPriceDrop && discountPct !== null && discountPct > 0 ? 5 : 0;
  let opportunityScore = Math.max(0, Math.min(100, Math.round(discountTerm + CONFIDENCE_POINTS[confidence] + dropBonus)));
  if (invalidTarget) opportunityScore = 0;
  else if (confidence === 'INSUFFICIENT' || flags.has('SUSPICIOUS_LOW')) opportunityScore = Math.min(opportunityScore, 50);

  const flagList = [...flags].sort();
  return {
    engineVersion: ENGINE_VERSION,
    estimatedPrice,
    priceDiff,
    discountPct,
    opportunityScore,
    comparableCount: ev.kept.length,
    confidence,
    expansionLevel: pick.level.level,
    flags: flagList,
    comparableIds: [...keptIds].sort((a, b) => a - b),
    explanation: {
      engineVersion: ENGINE_VERSION,
      level: pick.level.level,
      insufficient,
      insufficientReason,
      target: { price: Number(target.price), year: target.year, km: target.km, trim: target.trim, damaged: target.damaged },
      comparables: ev.entries
        .map((e) => ({
          id: e.c.id,
          price: Number(e.c.price),
          year: e.c.year,
          km: e.c.km,
          damaged: e.c.damaged,
          adjusted: Math.round(e.value),
          clamped: e.clamped,
          outlier: e.outlier,
        }))
        .sort((a, b) => a.id - b.id),
      confidenceSteps: steps,
      pool: {
        candidates: others.length,
        invalidPrice,
        afterDedup: base.length,
        inLevel: pick.inLvl.length,
        damagedExcluded: pick.inLvl.filter((c) => c.damaged && !keptIds.has(c.id)).length,
        used: ev.kept.length,
        outlierIds: ev.outlierIds,
      },
      adjustments: {
        yearAdjPct: s.yearAdjPct,
        kmMethod: ev.kmMethod,
        kmSlopePerKm: ev.slope === null ? null : round4(ev.slope),
        kmAdjPer10k: s.kmAdjPer10k,
        maxAdjPct: s.maxAdjPct,
      },
      stats: {
        q1: ev.q1 === null ? null : Math.round(ev.q1),
        median: ev.med === null ? null : Math.round(ev.med),
        q3: ev.q3 === null ? null : Math.round(ev.q3),
        dispersion: dispersion === null ? null : round4(dispersion),
      },
      flags: flagList,
      settings: { ...s },
    },
  };
}
