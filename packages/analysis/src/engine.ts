import { DEFAULT_SETTINGS, type AnalysisSettings } from './settings';
import { quantile, theilSenSlope } from './stats';
import type { AnalysisFlag, AnalysisResult, AnalysisTarget, Comparable, Confidence } from './types';

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

function applyDamagePolicy(t: AnalysisTarget, pool: Comparable[], min: number): { pool: Comparable[]; excluded: number } {
  if (t.damaged) return { pool, excluded: 0 };
  const clean = pool.filter((c) => !c.damaged);
  if (clean.length === pool.length || clean.length >= min) return { pool: clean, excluded: pool.length - clean.length };
  return { pool, excluded: 0 };
}

export function analyze(target: AnalysisTarget, candidates: Comparable[], settings: AnalysisSettings = DEFAULT_SETTINGS): AnalysisResult {
  const s = settings;
  const base = dedupe(candidates.filter((c) => c.id !== target.id));

  // 1) Kademeli havuz
  let chosen: { level: Level; pool: Comparable[]; excluded: number; inLevel: number } | null = null;
  for (const level of LEVELS) {
    const candidatesInLevel = base.filter((c) => inLevel(target, c, level));
    const p = applyDamagePolicy(target, candidatesInLevel, s.minComparables);
    if (p.pool.length >= s.minComparables) {
      chosen = { level, ...p, inLevel: candidatesInLevel.length };
      break;
    }
  }
  const expansionExhausted = chosen === null;
  if (!chosen) {
    const last = LEVELS[LEVELS.length - 1];
    const candidatesInLevel = base.filter((c) => inLevel(target, c, last));
    chosen = { level: last, ...applyDamagePolicy(target, candidatesInLevel, s.minComparables), inLevel: candidatesInLevel.length };
  }

  // 2) Yıl + km düzeltmesi (emsali hedefe uyarla), ±maxAdjPct ile sınırlı
  const withYear = chosen.pool.map((c) => ({
    c,
    original: Number(c.price),
    value: Number(c.price) * (1 + s.yearAdjPct) ** (target.year - c.year),
  }));
  let kmMethod: 'THEIL_SEN' | 'DEFAULT' | 'NONE' = withYear.length === 0 ? 'NONE' : 'DEFAULT';
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
    return { id: p.c.id, value };
  });

  // 3) IQR ile uç değer ayıklama
  let kept = adjusted;
  if (adjusted.length >= 4) {
    const sorted = adjusted.map((a) => a.value).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    kept = adjusted.filter((a) => a.value >= q1 - 1.5 * iqr && a.value <= q3 + 1.5 * iqr);
  }
  const keptIds = new Set(kept.map((k) => k.id));
  const outlierIds = adjusted.filter((a) => !keptIds.has(a.id)).map((a) => a.id).sort((a, b) => a - b);

  // 4) Tahmin
  let q1: number | null = null;
  let med: number | null = null;
  let q3: number | null = null;
  if (kept.length > 0) {
    const sorted = kept.map((k) => k.value).sort((a, b) => a - b);
    q1 = quantile(sorted, 0.25);
    med = quantile(sorted, 0.5);
    q3 = quantile(sorted, 0.75);
  }
  const estimatedPrice = med === null ? null : BigInt(Math.round(med));
  const priceDiff = estimatedPrice === null ? null : estimatedPrice - target.price;
  const discountPct =
    estimatedPrice === null || estimatedPrice === 0n
      ? null
      : Math.min(MAX_DISCOUNT, Math.max(MIN_DISCOUNT, round4(Number(priceDiff) / Number(estimatedPrice))));
  const dispersion = med !== null && med > 0 && q1 !== null && q3 !== null ? (q3 - q1) / med : null;

  // 5) Güvenilirlik ve bayraklar
  const flags = new Set<AnalysisFlag>();
  const insufficient = expansionExhausted || kept.length < s.minComparables;
  let confidence: Confidence = insufficient ? 'INSUFFICIENT' : chosen.level.cap;
  if (!insufficient && kept.length <= s.smallPoolMax) confidence = atMost(confidence, 'MEDIUM');
  if (dispersion !== null && dispersion > s.dispersionThreshold) {
    flags.add('HIGH_DISPERSION');
    if (!insufficient) confidence = downgrade(confidence);
  }
  if (target.damaged) {
    flags.add('DAMAGED');
    if (!insufficient) confidence = downgrade(confidence);
  }
  if (discountPct !== null && discountPct > s.suspiciousDiscount) {
    flags.add('SUSPICIOUS_LOW');
    if (!insufficient) confidence = atMost(confidence, 'LOW');
  }

  // 6) Fırsat puanı
  const discountTerm = discountPct === null ? 0 : Math.min(1, Math.max(0, discountPct / 0.3)) * 70;
  const dropBonus = target.hadPriceDrop && discountPct !== null && discountPct > 0 ? 5 : 0;
  const opportunityScore = Math.max(0, Math.min(100, Math.round(discountTerm + CONFIDENCE_POINTS[confidence] + dropBonus)));

  const flagList = [...flags].sort();
  return {
    engineVersion: ENGINE_VERSION,
    estimatedPrice,
    priceDiff,
    discountPct,
    opportunityScore,
    comparableCount: kept.length,
    confidence,
    expansionLevel: chosen.level.level,
    flags: flagList,
    comparableIds: [...keptIds].sort((a, b) => a - b),
    explanation: {
      engineVersion: ENGINE_VERSION,
      level: chosen.level.level,
      insufficient,
      pool: {
        candidates: candidates.length,
        afterDedup: base.length,
        inLevel: chosen.inLevel,
        damagedExcluded: chosen.excluded,
        used: kept.length,
        outlierIds,
      },
      adjustments: {
        yearAdjPct: s.yearAdjPct,
        kmMethod,
        kmSlopePerKm: slope === null ? null : round4(slope),
        kmAdjPer10k: s.kmAdjPer10k,
        maxAdjPct: s.maxAdjPct,
      },
      stats: {
        q1: q1 === null ? null : Math.round(q1),
        median: med === null ? null : Math.round(med),
        q3: q3 === null ? null : Math.round(q3),
        dispersion: dispersion === null ? null : round4(dispersion),
      },
      flags: flagList,
      settings: s,
    },
  };
}
