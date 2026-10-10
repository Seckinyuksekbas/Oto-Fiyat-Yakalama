import type { AnalysisSettings } from './settings';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
export type AnalysisFlag = 'DAMAGED' | 'SUSPICIOUS_LOW' | 'HIGH_DISPERSION';

/** Analiz edilen ilan. make/model/fuel/transmission eşleşmesini çağıran taraf yapar. */
export interface AnalysisTarget {
  id: number;
  trim: string | null;
  year: number;
  km: number;
  price: bigint;
  damaged: boolean;
  /** İlanın fiyat geçmişinde en az bir düşüş var mı */
  hadPriceDrop: boolean;
}

/** Aday emsal (aynı make/model/fuel/transmission, ±3 yıl, son 60 gün). */
export interface Comparable {
  id: number;
  title: string;
  trim: string | null;
  year: number;
  km: number;
  price: bigint;
  damaged: boolean;
}

export interface AnalysisExplanation {
  engineVersion: string;
  level: number;
  insufficient: boolean;
  pool: {
    candidates: number;
    afterDedup: number;
    inLevel: number;
    damagedExcluded: number;
    used: number;
    outlierIds: number[];
  };
  adjustments: {
    yearAdjPct: number;
    kmMethod: 'THEIL_SEN' | 'DEFAULT' | 'NONE';
    /** Theil–Sen eğimi (TL/km), yalnızca THEIL_SEN'de */
    kmSlopePerKm: number | null;
    kmAdjPer10k: number;
    maxAdjPct: number;
  };
  stats: { q1: number | null; median: number | null; q3: number | null; dispersion: number | null };
  flags: AnalysisFlag[];
  settings: AnalysisSettings;
}

export interface AnalysisResult {
  engineVersion: string;
  estimatedPrice: bigint | null;
  priceDiff: bigint | null;
  /** (tahmin − fiyat) / tahmin; 0.2 = %20 piyasa altı. [-99.9999, 0.9999] aralığında, 4 ondalık. */
  discountPct: number | null;
  opportunityScore: number;
  comparableCount: number;
  confidence: Confidence;
  expansionLevel: number;
  flags: AnalysisFlag[];
  comparableIds: number[];
  explanation: AnalysisExplanation;
}
