# Plan 03 — Fırsat Analiz Motoru Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Her aktif ilan için açıklanabilir, kural tabanlı (`rules-v1`) bir piyasa fiyatı tahmini, indirim oranı, güvenilirlik ve fırsat puanı üretmek; `analyze` kuyruğunu tüketmek ve eşleştirme için (Plan 04) `match` olaylarını güvenilir biçimde üretmek.

**Architecture:** Saf TypeScript `@oto/analysis` paketi (istatistik + motor, DB bağımsız) + `apps/worker` içinde `AnalysisModule` (DB'den hedef/emsal okur, motoru çalıştırır, sonucu yazar, olayı DB durumundan türetir, `match` işi gönderir) + `AnalyzeWorkerHost` (BullMQ tüketicisi) + scheduler'da gece yenilemesi ve bekleyen eşleştirme olaylarını yeniden kuyruğa alma.

**Tech Stack:** TypeScript, zod, NestJS 11 (app context), Prisma 6, BullMQ 5, ioredis, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md` §4 (analiz motoru), §1 (akış), §5.1 (olay türleri). Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md` (Plan 03 + "Plan 02 sonrası taşınan maddeler").

## Bu planın kararları (spec'i netleştiren)

| Konu | Karar | Gerekçe |
|---|---|---|
| Olay türetme | Tüketici iş verisindeki `reason`'a güvenmez; olayı DB'den türetir: önceki analiz yoksa `NEW`; `relistedAt` > son analiz → `RELIST`; içerik özeti aynıysa `REFRESH`; fiyat son analizdeki fiyattan düşükse `PRICE_DROP`; diğer değişiklik `CHANGE` | Birleştirilen/kaybolan kuyruk işleri yanlış veya eksik olay üretmez (yol haritası notu) |
| Kalıcı değişiklik işareti | `ListingAnalysis.listingPrice` + `listingContentHash` (analiz anındaki ilan durumu) | `Listing.changedAt` yerine; önceki fiyat ve "değişti mi" doğrudan son analizden okunur |
| Eşleştirme olayı | Yalnızca `NEW`, `PRICE_DROP`, `RELIST` → `match` kuyruğu (Plan 04 tüketir). `CHANGE`/`REFRESH` olay üretmez | Spec §4.7 ve §5.1 |
| Kayıp `match` işi | `ListingAnalysis.matchEvent` + `matchQueuedAt`; scheduler her tick'te 60 sn'den eski, kuyruğa alınmamış olayları yeniden gönderir (`jobId = match-<analysisId>` ile tekil) | Commit sonrası Redis hatasında bildirim kaybolmaz |
| Gece yenilemesi | İstanbul saatiyle 03:00'ten sonraki ilk tick'te, günde bir kez (Redis `SET NX`), tüm AKTİF ilanlar için `REFRESH` işi | Spec §4.7; `latestAnalysisId` boş ilanlar da bu taramayla telafi edilir |
| Aynı ilana eşzamanlı analiz | Redis kilidi (`lock:analyze:<id>`, 60 sn). Kilit doluysa iş yeniden denenir (BullMQ backoff) | Çift analiz satırı ve çift olay önlenir |
| Km aralığı | `|emsal.km − hedef.km| ≤ oran × max(hedef.km, 10.000)` | Sıfır km hedefte aralık sıfıra düşmez |
| ±%20 sınırı | Yıl + km düzeltmesinin toplamı emsalin kendi fiyatının %80–%120'si ile sınırlanır | Spec "toplam düzeltme ±%20" |
| Hasar tanımı | `tramerAmount > 0` veya `changedParts` dolu → hasarlı. Boyalı parça tek başına hasar sayılmaz | Spec §4.2 "tramer veya değişen parçası olan" |
| Fiyat düşüşü bonusu (+5) | Yalnızca indirim oranı > 0 iken | Emsalsiz ilana anlamsız puan verilmez |
| Uç değer sonrası emsal < 5 | `INSUFFICIENT` | Spec "kesin fırsat iddiası yok" |
| `discountPct` sınırı | [−99,9999; 0,9999] aralığına kırpılır | DB `Decimal(6,4)` taşmasın |

## Global Constraints

- Plan 01 ve Plan 02 Global Constraints maddeleri geçerlidir.
- `engineVersion = "rules-v1"`. Varsayılan ayarlar: `minComparables 5`, `yearAdjPct 0.07`, `kmAdjPer10k 0.02`, `maxAdjPct 0.2`, `theilSenMinPool 8`, `smallPoolMax 7`, `dispersionThreshold 0.25`, `suspiciousDiscount 0.45`, `poolWindowDays 60`, `refreshMinChangePct 0.02`. Ayarlar `SystemSetting` anahtarı `analysis.settings` ile kısmen ezilebilir (geçersizse varsayılan + uyarı).
- Seviye tablosu: L0 yıl ±0, km ±%25, aynı trim (hedefte varsa), tavan HIGH; L1 ±1, ±%25, trim serbest, HIGH; L2 ±2, ±%40, MEDIUM; L3 ±3, ±%60, LOW. ≥5 emsal bulunan ilk seviyede durulur.
- Emsal havuzu: aynı make + model + fuel + transmission, hedef hariç, son 60 günde görülmüş; `REMOVED` olanlar yalnızca son 60 günde kaldırıldıysa ve son fiyatlarıyla.
- Medyan + IQR (Q1 − 1,5·IQR, Q3 + 1,5·IQR) uç değer ayıklama; quantile doğrusal enterpolasyon (tip 7).
- Güven: seviye tavanı → emsal 5–7 ise en fazla MEDIUM → yayılım (IQR/medyan) > 0,25 ise bir kademe düş + `HIGH_DISPERSION` → hedef hasarlıysa bir kademe düş + `DAMAGED` → indirim > 0,45 ise en fazla LOW + `SUSPICIOUS_LOW`.
- Puan: `round(clamp(indirim/0,30, 0, 1)·70 + {HIGH 30, MEDIUM 18, LOW 6, INSUFFICIENT 0} + (fiyat düşüşü geçmişi ve indirim > 0 ise 5))`, 0–100.
- Para DB'de `BigInt`, kuyruk verisinde rakam dizgisi. `discountPct` kesir (0,20 = %20), 4 ondalık.
- Gece yenilemesi ve içeriği değişmemiş ilanın yeniden analizi `match` olayı üretmez; yeni analiz satırı yalnızca tahmin > %2 değiştiyse veya güven/motor sürümü değiştiyse yazılır.
- BullMQ job id'leri `:` içermez; yeniden denenen işler `attempts 5`, üstel `backoff 10 sn`, `removeOnComplete true`, `removeOnFail 24 saat`.

## Review Focus

1. **Seyrek piyasa (0–4 emsal):** Kesin fırsat iddiası olmamalı (`INSUFFICIENT`, güven puanı 0); hiç emsal yoksa tahmin `null`. → Task 2 testi.
2. **Saçma emsaller (10 kat fiyat yazım hatası, uç km):** Tahmini savurmamalı (IQR + ±%20 sınır). → Task 2 testi.
3. **Hasarlı veya aşırı ucuz hedef:** Yüksek puan/HIGH güven almamalı (`DAMAGED`, `SUSPICIOUS_LOW`). → Task 2 testi.
4. **Aynı ilan için eşzamanlı iki analiz (olay + gece):** Tek analiz satırı, tek olay. → Task 4 testi.
5. **İki fiyat düşüşü tek analizde birleşir / fiyat artar:** Olay son analiz edilen fiyata göre `PRICE_DROP`; fiyat artışı olay üretmez. → Task 4 testi.

## Dosya Haritası

```
packages/analysis/      src/{index,types,settings,stats,engine}.ts (+ stats.spec.ts, engine.spec.ts)
packages/shared/        src/queues.ts (+ REFRESH, MATCH, matchJobSchema) (+ spec)
packages/db/            prisma/schema.prisma (ListingAnalysis yeni alanlar), migrations/20261012000000_analysis_tracking/
apps/worker/src/queues/ job-options.ts, queue-registry.ts (+ match)
apps/worker/src/collection/ingest.service.ts (job-options kullanımı)
apps/worker/src/analysis/   {analysis.module,analysis-settings.service,analysis.service,match-dispatcher.service,events}.ts
apps/worker/src/processors/ analyze-worker.host.ts
apps/worker/src/scheduler/  analysis-sweep.service.ts, scheduler.module.ts, scheduler-loop.service.ts
apps/worker/src/config/env.ts (ANALYZE_CONCURRENCY)
apps/worker/src/{worker-app,scheduler-app}.module.ts
apps/worker/test/   helpers.ts (+createListing), analysis.e2e.spec.ts, analysis-sweep.e2e.spec.ts, pipeline.e2e.spec.ts
docs/analysis-engine.md, docs/architecture.md, docs/superpowers/plans/2026-10-10-00-roadmap.md
```

---

### Task 1: `@oto/analysis` — tipler, ayarlar, istatistik yardımcıları

**Files:**
- Create: `packages/analysis/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`
- Create: `packages/analysis/src/{index,types,settings,stats}.ts`
- Test: `packages/analysis/src/stats.spec.ts`

**Interfaces:**
- Produces: `Confidence`, `AnalysisFlag`, `AnalysisTarget`, `Comparable`, `AnalysisExplanation`, `AnalysisResult`; `analysisSettingsSchema`, `AnalysisSettings`, `DEFAULT_SETTINGS`; `quantile(sorted, p)`, `median(values)`, `theilSenSlope(points)`.

- [ ] **Step 1: Paket dosyaları**

`packages/analysis/package.json`:
```json
{
  "name": "@oto/analysis",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "vitest": "^3.0.5" }
}
```
`tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"]
}
```
`tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["src/**/*.spec.ts"] }
```
`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.spec.ts'] } });
```
Run: `pnpm install`

- [ ] **Step 2: Başarısız testi yaz** (`packages/analysis/src/stats.spec.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { analysisSettingsSchema, DEFAULT_SETTINGS, median, quantile, theilSenSlope } from './index';

describe('quantile / median', () => {
  it('uses linear interpolation (type 7)', () => {
    const s = [1, 2, 3, 4];
    expect(quantile(s, 0)).toBe(1);
    expect(quantile(s, 0.25)).toBe(1.75);
    expect(quantile(s, 0.5)).toBe(2.5);
    expect(quantile(s, 1)).toBe(4);
  });

  it('median sorts a copy and handles odd/even lengths', () => {
    const v = [5, 1, 3];
    expect(median(v)).toBe(3);
    expect(v).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('throws on empty input', () => {
    expect(() => quantile([], 0.5)).toThrow();
  });
});

describe('theilSenSlope', () => {
  it('recovers a linear slope and resists one outlier', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 10_000, y: 1_300_000 - i * 10_000 }));
    pts[5] = { x: 50_000, y: 9_000_000 };
    expect(theilSenSlope(pts)).toBeCloseTo(-1, 6);
  });

  it('returns null when all x are equal or there are fewer than 2 points', () => {
    expect(theilSenSlope([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBeNull();
    expect(theilSenSlope([{ x: 1, y: 1 }])).toBeNull();
  });

  it('samples large inputs deterministically', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 1000 - 2 * i }));
    expect(theilSenSlope(pts)).toBe(-2);
  });
});

describe('analysis settings', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      minComparables: 5,
      yearAdjPct: 0.07,
      kmAdjPer10k: 0.02,
      maxAdjPct: 0.2,
      theilSenMinPool: 8,
      smallPoolMax: 7,
      dispersionThreshold: 0.25,
      suspiciousDiscount: 0.45,
      poolWindowDays: 60,
      refreshMinChangePct: 0.02,
    });
  });

  it('accepts partial overrides and rejects unknown keys / bad ranges', () => {
    expect(analysisSettingsSchema.parse({ minComparables: 3 }).minComparables).toBe(3);
    expect(analysisSettingsSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(analysisSettingsSchema.safeParse({ yearAdjPct: 2 }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/analysis test`
Expected: FAIL — `./index` yok.

- [ ] **Step 4: Uygulamayı yaz**

`packages/analysis/src/types.ts`:
```ts
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
```

`packages/analysis/src/settings.ts`:
```ts
import { z } from 'zod';

export const analysisSettingsSchema = z
  .object({
    minComparables: z.number().int().min(2).max(50).default(5),
    yearAdjPct: z.number().min(0).max(0.3).default(0.07),
    kmAdjPer10k: z.number().min(0).max(0.2).default(0.02),
    maxAdjPct: z.number().min(0).max(0.5).default(0.2),
    theilSenMinPool: z.number().int().min(3).max(200).default(8),
    smallPoolMax: z.number().int().min(0).max(50).default(7),
    dispersionThreshold: z.number().min(0).max(2).default(0.25),
    suspiciousDiscount: z.number().min(0).max(1).default(0.45),
    poolWindowDays: z.number().int().min(7).max(365).default(60),
    refreshMinChangePct: z.number().min(0).max(1).default(0.02),
  })
  .strict();

export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

export const DEFAULT_SETTINGS: AnalysisSettings = analysisSettingsSchema.parse({});
```

`packages/analysis/src/stats.ts`:
```ts
/** Sıralı dizide doğrusal enterpolasyonlu quantile (R tip 7). */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('quantile: boş dizi');
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

const THEIL_SEN_MAX_POINTS = 300;

/** Uç değerlere dayanıklı eğim: ikili eğimlerin medyanı. Büyük girdide deterministik örnekleme yapar. */
export function theilSenSlope(points: { x: number; y: number }[]): number | null {
  let pts = points;
  if (pts.length > THEIL_SEN_MAX_POINTS) {
    const step = pts.length / THEIL_SEN_MAX_POINTS;
    pts = Array.from({ length: THEIL_SEN_MAX_POINTS }, (_, i) => points[Math.floor(i * step)]);
  }
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx !== 0) slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}
```

`packages/analysis/src/index.ts`:
```ts
export * from './types';
export * from './settings';
export * from './stats';
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm --filter @oto/analysis test && pnpm --filter @oto/analysis build && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(analysis): add analysis types, settings and robust statistics"
```

---

### Task 2: Kural tabanlı motor (`rules-v1`)

**Files:**
- Create: `packages/analysis/src/engine.ts`
- Modify: `packages/analysis/src/index.ts`
- Test: `packages/analysis/src/engine.spec.ts`

**Interfaces:**
- Consumes: Task 1 tipleri, `DEFAULT_SETTINGS`, `quantile`, `theilSenSlope`.
- Produces: `ENGINE_VERSION = 'rules-v1'`, `LEVELS`, `analyze(target, candidates, settings?) → AnalysisResult`.

- [ ] **Step 1: Başarısız testleri yaz** (`packages/analysis/src/engine.spec.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_SETTINGS, type AnalysisTarget, type Comparable } from './index';

const target = (over: Partial<AnalysisTarget> = {}): AnalysisTarget => ({
  id: 1, trim: '320i', year: 2019, km: 85_000, price: 960_000n, damaged: false, hadPriceDrop: false, ...over,
});

let seq = 100;
const comp = (over: Partial<Comparable> = {}): Comparable => {
  seq += 1;
  return { id: seq, title: `İlan ${seq}`, trim: '318i', year: 2019, km: 85_000, price: 1_200_000n, damaged: false, ...over };
};
const prices = (list: number[], over: Partial<Comparable> = {}) => list.map((p) => comp({ price: BigInt(p), ...over }));

describe('analyze — spec §4.8 reference example', () => {
  it('14 comparables at L1, 20% below → HIGH, score 77', () => {
    const pool = prices([1_110_000, 1_120_000, 1_130_000, 1_140_000, 1_150_000, 1_170_000, 1_190_000, 1_210_000, 1_230_000, 1_250_000, 1_260_000, 1_270_000, 1_280_000, 1_290_000]);
    const r = analyze(target(), pool);
    expect(r.engineVersion).toBe('rules-v1');
    expect(r.estimatedPrice).toBe(1_200_000n);
    expect(r.priceDiff).toBe(240_000n);
    expect(r.discountPct).toBe(0.2);
    expect(r.expansionLevel).toBe(1);
    expect(r.comparableCount).toBe(14);
    expect(r.confidence).toBe('HIGH');
    expect(r.flags).toEqual([]);
    expect(r.opportunityScore).toBe(77);
    expect(r.explanation.stats.dispersion).toBeLessThan(0.25);
    expect(r.comparableIds).toEqual([...r.comparableIds].sort((a, b) => a - b));
  });

  it('adds the price-drop bonus only when the listing is below market', () => {
    const pool = prices(Array.from({ length: 10 }, () => 1_200_000).map((p, i) => p + i * 1000));
    expect(analyze(target({ hadPriceDrop: true }), pool).opportunityScore).toBe(analyze(target(), pool).opportunityScore + 5);
    expect(analyze(target({ hadPriceDrop: true, price: 2_000_000n }), pool).opportunityScore).toBe(analyze(target({ price: 2_000_000n }), pool).opportunityScore);
  });
});

describe('analyze — pool expansion', () => {
  it('prefers L0 (same year, same trim)', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000, 1_205_000, 1_195_000, 1_200_000, 1_202_000, 1_198_000], { trim: '320i' }));
    expect(r.expansionLevel).toBe(0);
    expect(r.confidence).toBe('HIGH');
  });

  it('ignores trim at L0 when the target has none', () => {
    const r = analyze(target({ trim: null }), prices(Array.from({ length: 8 }, (_, i) => 1_200_000 + i * 1000)));
    expect(r.expansionLevel).toBe(0);
  });

  it('caps confidence by level: L2 → MEDIUM, L3 → LOW', () => {
    const l2 = analyze(target(), prices(Array.from({ length: 9 }, (_, i) => 1_000_000 + i * 1000), { year: 2017 }));
    expect(l2.expansionLevel).toBe(2);
    expect(l2.confidence).toBe('MEDIUM');
    const l3 = analyze(target(), prices(Array.from({ length: 9 }, (_, i) => 1_000_000 + i * 1000), { year: 2016 }));
    expect(l3.expansionLevel).toBe(3);
    expect(l3.confidence).toBe('LOW');
  });

  it('uses km windows relative to max(target km, 10.000)', () => {
    // 0 km hedef: L3 penceresi 0,6 × 10.000 = 6.000 km → 7.000 km'lik emsaller hiçbir seviyeye girmez, 5.000 km'likler L2'ye (4.000) girmez, L3'e girer
    const far = prices(Array.from({ length: 5 }, () => 1_000_000), { km: 7_000 });
    expect(analyze(target({ km: 0 }), far)).toMatchObject({ confidence: 'INSUFFICIENT', comparableCount: 0 });
    const mid = prices(Array.from({ length: 5 }, () => 1_000_000), { km: 5_000 });
    expect(analyze(target({ km: 0 }), mid).expansionLevel).toBe(3);
  });
});

describe('analyze — sparse markets (Review Focus #1)', () => {
  it('fewer than 5 comparables → INSUFFICIENT, no confidence points', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000]));
    expect(r.confidence).toBe('INSUFFICIENT');
    expect(r.estimatedPrice).toBe(1_200_000n);
    expect(r.opportunityScore).toBe(Math.round((0.2 / 0.3) * 70));
    expect(r.explanation.insufficient).toBe(true);
  });

  it('no comparables → null estimate, score 0 even with a price drop', () => {
    const r = analyze(target({ hadPriceDrop: true }), []);
    expect(r).toMatchObject({ estimatedPrice: null, priceDiff: null, discountPct: null, opportunityScore: 0, comparableCount: 0, confidence: 'INSUFFICIENT' });
  });

  it('respects a minComparables override', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000], { trim: '320i' }), { ...DEFAULT_SETTINGS, minComparables: 3 });
    expect(r.confidence).toBe('MEDIUM'); // 3 ≤ smallPoolMax
  });
});

describe('analyze — robustness (Review Focus #2)', () => {
  it('drops a 10x typo via IQR and reports it', () => {
    const pool = prices(Array.from({ length: 10 }, (_, i) => 1_180_000 + i * 5000));
    const typo = comp({ price: 12_000_000n });
    const r = analyze(target(), [...pool, typo]);
    expect(r.explanation.pool.outlierIds).toContain(typo.id);
    expect(r.comparableIds).not.toContain(typo.id);
    expect(Number(r.estimatedPrice)).toBeGreaterThan(1_180_000);
    expect(Number(r.estimatedPrice)).toBeLessThan(1_230_000);
  });

  it('counts duplicate reposts (same title, price, km) once', () => {
    const dup = Array.from({ length: 6 }, () => comp({ title: 'Aynı ilan', price: 1_000_000n }));
    const r = analyze(target(), [...dup, ...prices([1_200_000, 1_210_000, 1_190_000, 1_205_000])]);
    expect(r.explanation.pool.afterDedup).toBe(5);
  });

  it('clamps total adjustment to ±20% of the comparable price', () => {
    const r = analyze(target(), prices(Array.from({ length: 5 }, () => 1_000_000), { year: 2016 }));
    expect(r.estimatedPrice).toBe(1_200_000n); // 1.07^3 = 1.225 → %20'ye kırpılır
  });

  it('clamps an absurd negative discount into the DB range', () => {
    const r = analyze(target({ price: 50_000_000n }), prices(Array.from({ length: 6 }, () => 60_000)));
    expect(r.discountPct).toBe(-99.9999);
  });
});

describe('analyze — adjustments', () => {
  it('year: a one-year-older comparable is worth 7% more for the target', () => {
    const r = analyze(target(), prices(Array.from({ length: 5 }, () => 1_000_000), { year: 2018 }));
    expect(r.estimatedPrice).toBe(1_070_000n);
  });

  it('km default: 2% per 10.000 km when the pool is small', () => {
    const r = analyze(target({ km: 60_000 }), prices(Array.from({ length: 5 }, () => 1_200_000), { km: 80_000, trim: '320i' }));
    expect(r.explanation.adjustments.kmMethod).toBe('DEFAULT');
    expect(r.estimatedPrice).toBe(1_248_000n);
  });

  it('km Theil–Sen when the pool has ≥ 8 points', () => {
    const pool = Array.from({ length: 12 }, (_, i) => {
      const km = 70_000 + i * 5000;
      return comp({ km, price: BigInt(1_300_000 - km), trim: '320i' });
    });
    const r = analyze(target({ km: 100_000 }), pool);
    expect(r.explanation.adjustments.kmMethod).toBe('THEIL_SEN');
    expect(r.explanation.adjustments.kmSlopePerKm).toBeCloseTo(-1, 6);
    expect(r.estimatedPrice).toBe(1_200_000n);
  });

  it('falls back to the default when the fitted slope is not negative', () => {
    const pool = Array.from({ length: 10 }, (_, i) => comp({ km: 70_000 + i * 5000, price: BigInt(1_000_000 + i * 10_000), trim: '320i' }));
    expect(analyze(target({ km: 90_000 }), pool).explanation.adjustments.kmMethod).toBe('DEFAULT');
  });
});

describe('analyze — confidence and flags (Review Focus #3)', () => {
  it('5–7 comparables cap at MEDIUM', () => {
    const r = analyze(target(), prices([1_200_000, 1_210_000, 1_190_000, 1_205_000, 1_195_000, 1_200_000], { trim: '320i' }));
    expect(r.confidence).toBe('MEDIUM');
  });

  it('high dispersion downgrades and flags', () => {
    const r = analyze(target(), prices([800_000, 900_000, 1_000_000, 1_100_000, 1_300_000, 1_400_000, 1_500_000, 1_600_000, 1_200_000, 1_250_000], { trim: '320i' }));
    expect(r.flags).toContain('HIGH_DISPERSION');
    expect(r.confidence).toBe('MEDIUM');
  });

  it('a damaged target is flagged and downgraded', () => {
    const pool = prices(Array.from({ length: 10 }, (_, i) => 1_195_000 + i * 1000), { trim: '320i' });
    const r = analyze(target({ damaged: true }), pool);
    expect(r.flags).toContain('DAMAGED');
    expect(r.confidence).toBe('MEDIUM');
  });

  it('excludes damaged comparables for a clean target when enough clean ones remain', () => {
    const clean = prices(Array.from({ length: 6 }, (_, i) => 1_200_000 + i * 1000), { trim: '320i' });
    const damaged = prices([800_000, 810_000, 820_000], { trim: '320i', damaged: true });
    const r = analyze(target(), [...clean, ...damaged]);
    expect(r.explanation.pool.damagedExcluded).toBe(3);
    expect(r.comparableIds.some((id) => damaged.some((d) => d.id === id))).toBe(false);
  });

  it('keeps damaged comparables when clean ones are too few', () => {
    const clean = prices([1_200_000, 1_210_000, 1_190_000], { trim: '320i' });
    const damaged = prices([1_100_000, 1_110_000, 1_120_000], { trim: '320i', damaged: true });
    expect(analyze(target(), [...clean, ...damaged]).explanation.pool.damagedExcluded).toBe(0);
  });

  it('a suspiciously cheap listing is capped at LOW', () => {
    const r = analyze(target({ price: 600_000n }), prices(Array.from({ length: 10 }, (_, i) => 1_195_000 + i * 1000), { trim: '320i' }));
    expect(r.flags).toContain('SUSPICIOUS_LOW');
    expect(r.confidence).toBe('LOW');
    expect(r.opportunityScore).toBe(70 + 6);
  });
});

describe('analyze — explanation', () => {
  it('records the inputs needed to explain the estimate', () => {
    const r = analyze(target(), prices(Array.from({ length: 10 }, (_, i) => 1_195_000 + i * 1000), { trim: '320i' }));
    expect(r.explanation).toMatchObject({
      engineVersion: 'rules-v1',
      level: 0,
      insufficient: false,
      pool: { candidates: 10, afterDedup: 10, inLevel: 10, damagedExcluded: 0, used: 10, outlierIds: [] },
      adjustments: { yearAdjPct: 0.07, kmAdjPer10k: 0.02, maxAdjPct: 0.2 },
      settings: DEFAULT_SETTINGS,
    });
    expect(r.explanation.stats.median).toBe(Number(r.estimatedPrice));
  });

  it('never uses the target itself as a comparable', () => {
    const self = comp({ id: 1, price: 1n });
    const r = analyze(target(), [self, ...prices(Array.from({ length: 5 }, () => 1_200_000), { trim: '320i' })]);
    expect(r.comparableIds).not.toContain(1);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/analysis test`
Expected: FAIL — `analyze` yok.

- [ ] **Step 3: Motoru yaz** (`packages/analysis/src/engine.ts`)

```ts
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
```

`packages/analysis/src/index.ts` sonuna ekle: `export * from './engine';`

- [ ] **Step 4: Testleri çalıştır**

Run: `pnpm --filter @oto/analysis test && pnpm --filter @oto/analysis build && pnpm lint && pnpm typecheck`
Expected: PASS. Bir test motorla çelişiyorsa önce hesabı elle doğrula (ör. Theil–Sen, IQR sınırları); testin ifade ettiği davranış spec'e uyuyorsa motoru düzelt, testi zayıflatma.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(analysis): add rules-v1 opportunity engine with tiered comparables and explainable output"
```

---

### Task 3: Sözleşmeler — kuyruk, şema, iş seçenekleri

**Files:**
- Modify: `packages/shared/src/queues.ts`, `packages/shared/src/queues.spec.ts`
- Modify: `packages/db/prisma/schema.prisma`; Create: `packages/db/prisma/migrations/20261012000000_analysis_tracking/migration.sql`
- Create: `apps/worker/src/queues/job-options.ts`; Modify: `apps/worker/src/queues/queue-registry.ts`, `apps/worker/src/collection/ingest.service.ts`, `apps/worker/test/core.e2e.spec.ts`

**Interfaces:**
- Produces: `QueueName.MATCH = 'match'`; `analyzeReasonSchema` + `'REFRESH'`; `matchEventSchema` (`'NEW'|'PRICE_DROP'|'RELIST'`), `MatchEvent`, `matchJobSchema`/`MatchJobData` `{ listingId, analysisId, event, previousPrice? }`; `ListingAnalysis.listingPrice BigInt?`, `listingContentHash String?`, `matchEvent MatchReason?`, `matchPreviousPrice BigInt?`, `matchQueuedAt DateTime?`; `RETRYING_JOB_OPTS`; `QueueRegistry.match`.

- [ ] **Step 1: Başarısız testleri yaz**

`packages/shared/src/queues.spec.ts` sonuna (describe içine) ekle:
```ts
  it('accepts REFRESH for analyze and validates match jobs', () => {
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'REFRESH' }).success).toBe(true);
    expect(QueueName.MATCH).toBe('match');
    expect(matchJobSchema.parse({ listingId: 1, analysisId: 2, event: 'PRICE_DROP', previousPrice: '960000' })).toEqual({ listingId: 1, analysisId: 2, event: 'PRICE_DROP', previousPrice: '960000' });
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 2, event: 'CHANGE' }).success).toBe(false);
  });
```
(import'a `matchJobSchema` ekle.)

`apps/worker/test/core.e2e.spec.ts` içindeki QueueRegistry testini şu hale getir:
```ts
  it('exposes the scrape, analyze and match queues', () => {
    const q = ref.get(QueueRegistry);
    expect([q.scrape.name, q.analyze.name, q.match.name]).toEqual(['scrape', 'analyze', 'match']);
  });
```

Run: `pnpm --filter @oto/shared test` → FAIL.

- [ ] **Step 2: Kuyruk sözleşmesi** — `packages/shared/src/queues.ts`

`QueueName`'e ekle: `MATCH: 'match',`
`analyzeReasonSchema`'yı şu yap:
```ts
/** İpucu niteliğindedir: tüketici asıl olayı DB durumundan türetir. REFRESH = gece yeniden analizi. */
export const analyzeReasonSchema = z.enum(['NEW', 'PRICE_CHANGE', 'RELIST', 'UPDATE', 'REFRESH']);
```
`previousPrice` yorumunu şu yap: `/** Önceki fiyat (TL, rakam dizgisi) — fiyat değiştiğinde (PRICE_CHANGE veya fiyatı değişmiş RELIST) */`
Dosya sonuna ekle:
```ts
export const matchEventSchema = z.enum(['NEW', 'PRICE_DROP', 'RELIST']);
export type MatchEvent = z.infer<typeof matchEventSchema>;

/** Plan 04 (eşleştirme) tüketir. Tüketici güncel DB durumunu okumalıdır. */
export const matchJobSchema = z.object({
  listingId: z.number().int().positive(),
  analysisId: z.number().int().positive(),
  event: matchEventSchema,
  /** PRICE_DROP'ta, son analiz edilen fiyat (TL, rakam dizgisi) */
  previousPrice: z.string().regex(/^\d+$/).optional(),
});
export type MatchJobData = z.infer<typeof matchJobSchema>;
```

Run: `pnpm --filter @oto/shared test && pnpm --filter @oto/shared build` → PASS.

- [ ] **Step 3: Şema ve migration**

`packages/db/prisma/schema.prisma` → `model ListingAnalysis` içinde `createdAt` satırından önce ekle:
```prisma
  /// Analiz anındaki ilan fiyatı ve içerik özeti: sonraki analizde "ne değişti" buradan anlaşılır
  listingPrice       BigInt?
  listingContentHash String?
  /// Bu analizin ürettiği eşleştirme olayı (NEW/PRICE_DROP/RELIST) ve kuyruğa alınma zamanı
  matchEvent         MatchReason?
  matchPreviousPrice BigInt?
  matchQueuedAt      DateTime?
```
ve `@@index([confidence, opportunityScore])` satırının altına:
```prisma
  @@index([matchEvent, matchQueuedAt])
```
Migration:
```bash
git show HEAD:packages/db/prisma/schema.prisma > "$TEMP/schema-before.prisma"
mkdir -p packages/db/prisma/migrations/20261012000000_analysis_tracking
pnpm --filter @oto/db exec prisma migrate diff --from-schema-datamodel "$TEMP/schema-before.prisma" --to-schema-datamodel prisma/schema.prisma --script -o prisma/migrations/20261012000000_analysis_tracking/migration.sql
```
Expected `migration.sql`: yalnızca `ListingAnalysis`'e 5 sütun ve bir index ekler. Run: `pnpm build:packages`.

- [ ] **Step 4: Ortak iş seçenekleri ve match kuyruğu**

`apps/worker/src/queues/job-options.ts`:
```ts
import type { JobsOptions } from 'bullmq';

/** Yeniden denenen işler: 5 deneme, üstel bekleme; tamamlanınca silinir (tekilleştirme yalnızca beklerken). */
export const RETRYING_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};
```

`apps/worker/src/queues/queue-registry.ts`: `match` kuyruğunu ekle (import'a `MatchJobData`):
```ts
  readonly match: Queue<MatchJobData>;
  // constructor içinde:
    this.match = new Queue<MatchJobData>(QueueName.MATCH, { connection });
  // error listener'larıyla aynı biçimde match için de .on('error', ...) ekle
  // onModuleDestroy içinde: this.match.close() de kapatılsın
```

`apps/worker/src/collection/ingest.service.ts` → `enqueueAnalyze` içindeki elle yazılmış seçenekleri `...RETRYING_JOB_OPTS` ile değiştir (jobId kalır):
```ts
    await this.queues.analyze.add('analyze', data, { jobId: analyzeJobId(listingId, reason, contentHash), ...RETRYING_JOB_OPTS });
```
(Mevcut ingest testi `attempts 5`, `backoff`, `removeOnComplete true`, `removeOnFail { age: 86400 }` beklediği için yeşil kalmalıdır.)

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm build:packages && pnpm --filter @oto/shared test && pnpm --filter @oto/worker test:e2e && pnpm --filter @oto/db test:e2e && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add match queue contract, analysis tracking columns and shared retry options"
```

---

### Task 4: `AnalysisService` — DB'den analiz, olay türetme, eşleştirme olayı

**Files:**
- Create: `apps/worker/src/analysis/{analysis.module,analysis-settings.service,analysis.service,match-dispatcher.service,events}.ts`
- Modify: `apps/worker/package.json` (dep `@oto/analysis`), `apps/worker/test/helpers.ts`
- Test: `apps/worker/test/analysis.e2e.spec.ts`

**Interfaces:**
- Consumes: `analyze`, `analysisSettingsSchema`, `DEFAULT_SETTINGS`, `AnalysisResult` (`@oto/analysis`); `MatchJobData`, `MatchEvent` (`@oto/shared`); `QueueRegistry.match`, `RETRYING_JOB_OPTS`.
- Produces:
  - `events.ts`: `AnalysisEvent = 'NEW'|'PRICE_DROP'|'RELIST'|'CHANGE'|'REFRESH'`; `deriveEvent(listing, latest)`; `isMatchEvent(e)`; `isDamaged(damageInfo)`; `materiallyChanged(latest, result, settings)`.
  - `ANALYSIS_SETTINGS_KEY = 'analysis.settings'`; `AnalysisSettingsService.get()`, `.invalidate()`.
  - `MatchDispatcher.dispatch({ analysisId, listingId, event, previousPrice })`.
  - `AnalysisLockBusyError`; `AnalyzeOutcome { status: 'WRITTEN'|'UNCHANGED'|'SKIPPED'; event: AnalysisEvent|null; analysisId: number|null }`; `AnalysisService.process(listingId, now?)`.
  - `AnalysisModule` (exports AnalysisService, AnalysisSettingsService, MatchDispatcher). Test helper `createListing(ref, sourceId, over?)`.

- [ ] **Step 1: Bağımlılık ve test yardımcısı**

`apps/worker/package.json` `dependencies`'e `"@oto/analysis": "workspace:*"` ekle; `pnpm install`.

`apps/worker/test/helpers.ts` sonuna ekle (import'a `type Listing` from `@oto/db`):
```ts
let listingSeq = 0;
export async function createListing(ref: TestingModule, sourceId: number, over: Record<string, unknown> = {}): Promise<Listing> {
  listingSeq += 1;
  return ref.get(PrismaService).listing.create({
    data: {
      sourceId,
      externalId: `T${listingSeq}`,
      url: `http://demo/ilan/T${listingSeq}`,
      title: `İlan T${listingSeq}`,
      make: 'BMW',
      model: '3 Serisi',
      trim: '318i',
      year: 2019,
      km: 85_000,
      fuel: 'GASOLINE',
      transmission: 'AUTOMATIC',
      price: 1_200_000n,
      contentHash: `h${listingSeq}`,
      ...over,
    },
  });
}
```

- [ ] **Step 2: Başarısız testi yaz** (`apps/worker/test/analysis.e2e.spec.ts`)

```ts
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { ANALYSIS_SETTINGS_KEY, AnalysisSettingsService } from '../src/analysis/analysis-settings.service';
import { AnalysisLockBusyError, AnalysisService } from '../src/analysis/analysis.service';
import { PrismaService } from '../src/infra/prisma.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createContext, createListing, createSource, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let service: AnalysisService;
let sourceId: number;

const MARKET = [1_110_000, 1_120_000, 1_130_000, 1_140_000, 1_150_000, 1_170_000, 1_190_000, 1_210_000, 1_230_000, 1_250_000, 1_260_000, 1_270_000, 1_280_000, 1_290_000];

beforeAll(async () => {
  ref = await createContext([AnalysisModule]);
  prisma = ref.get(PrismaService);
  service = ref.get(AnalysisService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  ref.get(AnalysisSettingsService).invalidate();
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function seedMarket(over: Record<string, unknown> = {}) {
  for (const p of MARKET) await createListing(ref, sourceId, { price: BigInt(p), ...over });
}
const matchJobs = () => ref.get(QueueRegistry).match.getJobs(['waiting', 'delayed']);

describe('AnalysisService.process', () => {
  it('analyzes a NEW listing, stores the analyzed state and emits a NEW match event', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { trim: '320i', price: 960_000n });
    const out = await service.process(t.id);
    expect(out).toMatchObject({ status: 'WRITTEN', event: 'NEW' });
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect(a).toMatchObject({ estimatedPrice: 1_200_000n, confidence: 'HIGH', opportunityScore: 77, listingPrice: 960_000n, listingContentHash: t.contentHash, matchEvent: 'NEW', comparableCount: 14 });
    expect(Number(a.discountPct)).toBe(0.2);
    expect(a.matchQueuedAt).not.toBeNull();
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: t.id } })).latestAnalysisId).toBe(a.id);
    const [job] = await matchJobs();
    expect(job.id).toBe(`match-${a.id}`);
    expect(job.data).toEqual({ listingId: t.id, analysisId: a.id, event: 'NEW' });
  });

  it('a nightly refresh without content or market change writes nothing and emits nothing', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    await service.process(t.id);
    const again = await service.process(t.id);
    expect(again).toMatchObject({ status: 'UNCHANGED', event: 'REFRESH' });
    expect(await prisma.listingAnalysis.count()).toBe(1);
    expect(await matchJobs()).toHaveLength(1);
  });

  it('a refresh after the market moved > 2% writes a new row but emits no match event', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    await service.process(t.id);
    await prisma.listing.updateMany({ where: { id: { not: t.id } }, data: { price: { increment: 100_000n } } });
    const out = await service.process(t.id);
    expect(out).toMatchObject({ status: 'WRITTEN', event: 'REFRESH' });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } })).matchEvent).toBeNull();
    expect(await matchJobs()).toHaveLength(1);
  });

  it('two price drops before analysis collapse into one PRICE_DROP vs the last analyzed price (Review Focus #5)', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 1_100_000n });
    await service.process(t.id);
    await prisma.listing.update({ where: { id: t.id }, data: { price: 1_050_000n, contentHash: 'c2' } });
    await prisma.listing.update({ where: { id: t.id }, data: { price: 980_000n, contentHash: 'c3' } });
    const out = await service.process(t.id);
    expect(out.event).toBe('PRICE_DROP');
    const job = (await matchJobs()).find((j) => j.data.analysisId === out.analysisId);
    expect(job?.data).toMatchObject({ event: 'PRICE_DROP', previousPrice: '1100000' });
  });

  it('a price increase is a CHANGE: new analysis, no match event', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 1_000_000n });
    await service.process(t.id);
    await prisma.listing.update({ where: { id: t.id }, data: { price: 1_050_000n, contentHash: 'up' } });
    expect(await service.process(t.id)).toMatchObject({ status: 'WRITTEN', event: 'CHANGE' });
    expect(await matchJobs()).toHaveLength(1);
  });

  it('a relisted listing emits RELIST even when its content is unchanged', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 1_000_000n });
    await service.process(t.id);
    await prisma.listing.update({ where: { id: t.id }, data: { relistedAt: new Date(Date.now() + 1000) } });
    expect(await service.process(t.id)).toMatchObject({ status: 'WRITTEN', event: 'RELIST' });
  });

  it('skips REMOVED and unknown listings', async () => {
    const t = await createListing(ref, sourceId, { status: 'REMOVED' });
    expect(await service.process(t.id)).toEqual({ status: 'SKIPPED', event: null, analysisId: null });
    expect(await service.process(999_999)).toEqual({ status: 'SKIPPED', event: null, analysisId: null });
  });

  it('builds the comparable pool from the 60-day window, same fuel/transmission, recent removals only', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 61 * 24 * 3600_000);
    await seedMarket();
    await createListing(ref, sourceId, { price: 10_000_000n, lastSeenAt: old });
    await createListing(ref, sourceId, { price: 10_000_000n, fuel: 'DIESEL' });
    await createListing(ref, sourceId, { price: 10_000_000n, status: 'REMOVED', removedAt: old, lastSeenAt: now });
    await createListing(ref, sourceId, { price: 1_200_000n, status: 'REMOVED', removedAt: now });
    const t = await createListing(ref, sourceId, { price: 960_000n });
    const out = await service.process(t.id, now);
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect((a.explanation as { pool: { candidates: number } }).pool.candidates).toBe(15);
  });

  it('uses price history for the drop bonus and damageInfo for flags', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n, damageInfo: { tramerAmount: 15000, paintedParts: [], changedParts: [] } });
    await prisma.listingPriceHistory.createMany({ data: [{ listingId: t.id, price: 1_000_000n, km: 85_000, observedAt: new Date(Date.now() - 2000) }, { listingId: t.id, price: 960_000n, km: 85_000 }] });
    const out = await service.process(t.id);
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect(a.flags).toContain('DAMAGED');
    expect(a.confidence).toBe('MEDIUM');
    expect(a.opportunityScore).toBe(Math.round((0.2 / 0.3) * 70) + 18 + 5);
  });

  it('serializes concurrent analyses of the same listing (Review Focus #4)', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    const results = await Promise.allSettled([service.process(t.id), service.process(t.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AnalysisLockBusyError);
    expect(await prisma.listingAnalysis.count()).toBe(1);
  });

  it('applies valid settings overrides and ignores invalid ones', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    await prisma.systemSetting.create({ data: { key: ANALYSIS_SETTINGS_KEY, value: { minComparables: 20 } } });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: (await service.process(t.id)).analysisId! } })).confidence).toBe('INSUFFICIENT');
    await prisma.systemSetting.update({ where: { key: ANALYSIS_SETTINGS_KEY }, data: { value: { minComparables: 'many' } } });
    ref.get(AnalysisSettingsService).invalidate();
    await prisma.listing.update({ where: { id: t.id }, data: { price: 950_000n, contentHash: 'x' } });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: (await service.process(t.id)).analysisId! } })).confidence).toBe('HIGH');
  });

  it('keeps the analysis even when the match queue is unavailable (requeued later)', async () => {
    await seedMarket();
    const t = await createListing(ref, sourceId, { price: 960_000n });
    const { vi } = await import('vitest');
    const spy = vi.spyOn(ref.get(QueueRegistry).match, 'add').mockRejectedValueOnce(new Error('redis down'));
    const out = await service.process(t.id);
    spy.mockRestore();
    expect(out.status).toBe('WRITTEN');
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: out.analysisId! } });
    expect(a).toMatchObject({ matchEvent: 'NEW', matchQueuedAt: null });
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm build:packages && pnpm --filter @oto/worker test:e2e`
Expected: FAIL — `../src/analysis/...` yok.

- [ ] **Step 4: Uygulamayı yaz**

`apps/worker/src/analysis/events.ts`:
```ts
import type { AnalysisResult, AnalysisSettings } from '@oto/analysis';
import type { MatchEvent } from '@oto/shared';

export type AnalysisEvent = 'NEW' | 'PRICE_DROP' | 'RELIST' | 'CHANGE' | 'REFRESH';

export interface ListingState {
  price: bigint;
  contentHash: string;
  relistedAt: Date | null;
}

export interface AnalyzedState {
  createdAt: Date;
  listingPrice: bigint | null;
  listingContentHash: string | null;
}

/** Olay, kuyruk verisinden değil ilanın güncel durumu ile son analiz arasındaki farktan türetilir. */
export function deriveEvent(listing: ListingState, latest: AnalyzedState | null): AnalysisEvent {
  if (!latest) return 'NEW';
  if (listing.relistedAt && listing.relistedAt > latest.createdAt) return 'RELIST';
  if (latest.listingContentHash === listing.contentHash) return 'REFRESH';
  if (latest.listingPrice !== null && listing.price < latest.listingPrice) return 'PRICE_DROP';
  return 'CHANGE';
}

export function isMatchEvent(e: AnalysisEvent): e is MatchEvent {
  return e === 'NEW' || e === 'PRICE_DROP' || e === 'RELIST';
}

/** Spec §4.2: tramer veya değişen parça → hasarlı. Boyalı parça tek başına hasar sayılmaz. */
export function isDamaged(info: unknown): boolean {
  if (!info || typeof info !== 'object') return false;
  const d = info as { tramerAmount?: unknown; changedParts?: unknown };
  return (typeof d.tramerAmount === 'number' && d.tramerAmount > 0) || (Array.isArray(d.changedParts) && d.changedParts.length > 0);
}

/** Gece yenilemesinde yeni satır yalnızca anlamlı değişiklikte yazılır. */
export function materiallyChanged(
  latest: { engineVersion: string; confidence: string; estimatedPrice: bigint | null },
  result: AnalysisResult,
  settings: AnalysisSettings,
): boolean {
  if (latest.engineVersion !== result.engineVersion || latest.confidence !== result.confidence) return true;
  const a = latest.estimatedPrice;
  const b = result.estimatedPrice;
  if (a === null || b === null) return a !== b;
  if (a === 0n) return b !== 0n;
  return Math.abs(Number(b - a)) / Number(a) > settings.refreshMinChangePct;
}
```

`apps/worker/src/analysis/analysis-settings.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { analysisSettingsSchema, DEFAULT_SETTINGS, type AnalysisSettings } from '@oto/analysis';
import { PrismaService } from '../infra/prisma.service';

export const ANALYSIS_SETTINGS_KEY = 'analysis.settings';
const CACHE_MS = 60_000;

@Injectable()
export class AnalysisSettingsService {
  private readonly logger = new Logger(AnalysisSettingsService.name);
  private cache?: { at: number; value: AnalysisSettings };

  constructor(private readonly prisma: PrismaService) {}

  async get(now = Date.now()): Promise<AnalysisSettings> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ANALYSIS_SETTINGS_KEY } });
    let value = DEFAULT_SETTINGS;
    if (row) {
      const parsed = analysisSettingsSchema.safeParse(row.value);
      if (parsed.success) value = parsed.data;
      else this.logger.warn(`Geçersiz ${ANALYSIS_SETTINGS_KEY}; varsayılanlar kullanılıyor: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    this.cache = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
```

`apps/worker/src/analysis/match-dispatcher.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { MatchEvent, MatchJobData } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RETRYING_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export interface PendingMatch {
  analysisId: number;
  listingId: number;
  event: MatchEvent;
  previousPrice: bigint | null;
}

export function matchJobId(analysisId: number): string {
  return `match-${analysisId}`;
}

@Injectable()
export class MatchDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** Kuyruğa ekler ve analize `matchQueuedAt` yazar. jobId analiz başına tekil olduğundan tekrar çağrı güvenlidir. */
  async dispatch(m: PendingMatch): Promise<void> {
    const data: MatchJobData = {
      listingId: m.listingId,
      analysisId: m.analysisId,
      event: m.event,
      ...(m.event === 'PRICE_DROP' && m.previousPrice !== null ? { previousPrice: m.previousPrice.toString() } : {}),
    };
    await this.queues.match.add('match', data, { jobId: matchJobId(m.analysisId), ...RETRYING_JOB_OPTS });
    await this.prisma.listingAnalysis.update({ where: { id: m.analysisId }, data: { matchQueuedAt: new Date() } });
  }
}
```

`apps/worker/src/analysis/analysis.service.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { analyze } from '@oto/analysis';
import { Prisma } from '@oto/db';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { AnalysisSettingsService } from './analysis-settings.service';
import { deriveEvent, isDamaged, isMatchEvent, materiallyChanged, type AnalysisEvent } from './events';
import { MatchDispatcher } from './match-dispatcher.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60_000;
const MAX_CANDIDATES = 1000;

export class AnalysisLockBusyError extends Error {
  constructor(listingId: number) {
    super(`İlan ${listingId} şu anda başka bir süreç tarafından analiz ediliyor`);
    this.name = 'AnalysisLockBusyError';
  }
}

export interface AnalyzeOutcome {
  status: 'WRITTEN' | 'UNCHANGED' | 'SKIPPED';
  event: AnalysisEvent | null;
  analysisId: number | null;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly settings: AnalysisSettingsService,
    private readonly matches: MatchDispatcher,
  ) {}

  /** Kilit doluysa AnalysisLockBusyError fırlatır; BullMQ işi geri çekilmeyle yeniden dener. */
  async process(listingId: number, now: Date = new Date()): Promise<AnalyzeOutcome> {
    const lockKey = `lock:analyze:${listingId}`;
    const token = randomUUID();
    if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') throw new AnalysisLockBusyError(listingId);
    try {
      return await this.processLocked(listingId, now);
    } finally {
      if ((await this.redis.get(lockKey)) === token) await this.redis.del(lockKey);
    }
  }

  private async processLocked(listingId: number, now: Date): Promise<AnalyzeOutcome> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, include: { latestAnalysis: true } });
    if (!listing || listing.status !== 'ACTIVE') return { status: 'SKIPPED', event: null, analysisId: null };

    const settings = await this.settings.get();
    const since = new Date(now.getTime() - settings.poolWindowDays * DAY_MS);
    const [candidates, history] = await Promise.all([
      this.prisma.listing.findMany({
        where: {
          id: { not: listing.id },
          make: listing.make,
          model: listing.model,
          fuel: listing.fuel,
          transmission: listing.transmission,
          year: { gte: listing.year - 3, lte: listing.year + 3 },
          lastSeenAt: { gte: since },
          OR: [{ status: 'ACTIVE' }, { status: 'REMOVED', removedAt: { gte: since } }],
        },
        select: { id: true, title: true, trim: true, year: true, km: true, price: true, damageInfo: true },
        orderBy: { lastSeenAt: 'desc' },
        take: MAX_CANDIDATES,
      }),
      this.prisma.listingPriceHistory.findMany({ where: { listingId }, orderBy: { observedAt: 'asc' }, select: { price: true } }),
    ]);

    const result = analyze(
      {
        id: listing.id,
        trim: listing.trim,
        year: listing.year,
        km: listing.km,
        price: listing.price,
        damaged: isDamaged(listing.damageInfo),
        hadPriceDrop: history.some((h, i) => i > 0 && h.price < history[i - 1].price),
      },
      candidates.map((c) => ({ id: c.id, title: c.title, trim: c.trim, year: c.year, km: c.km, price: c.price, damaged: isDamaged(c.damageInfo) })),
      settings,
    );

    const latest = listing.latestAnalysis;
    const event = deriveEvent(listing, latest);
    if (event === 'REFRESH' && latest && !materiallyChanged(latest, result, settings)) {
      return { status: 'UNCHANGED', event, analysisId: latest.id };
    }

    const matchEvent = isMatchEvent(event) ? event : null;
    const matchPreviousPrice = event === 'PRICE_DROP' ? (latest?.listingPrice ?? null) : null;
    const analysis = await this.prisma.$transaction(async (tx) => {
      const created = await tx.listingAnalysis.create({
        data: {
          listingId: listing.id,
          engineVersion: result.engineVersion,
          estimatedPrice: result.estimatedPrice,
          priceDiff: result.priceDiff,
          discountPct: result.discountPct === null ? null : new Prisma.Decimal(result.discountPct.toFixed(4)),
          opportunityScore: result.opportunityScore,
          comparableCount: result.comparableCount,
          confidence: result.confidence,
          expansionLevel: result.expansionLevel,
          flags: result.flags,
          explanation: result.explanation as unknown as Prisma.InputJsonValue,
          comparableIds: result.comparableIds,
          listingPrice: listing.price,
          listingContentHash: listing.contentHash,
          matchEvent,
          matchPreviousPrice,
        },
      });
      await tx.listing.update({ where: { id: listing.id }, data: { latestAnalysisId: created.id } });
      return created;
    });

    if (matchEvent) {
      try {
        await this.matches.dispatch({ analysisId: analysis.id, listingId: listing.id, event: matchEvent, previousPrice: matchPreviousPrice });
      } catch (err) {
        // Analiz kalıcı; scheduler kuyruğa alınmamış olayları yeniden gönderir.
        this.logger.warn(`Eşleştirme olayı kuyruğa alınamadı (analiz ${analysis.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { status: 'WRITTEN', event, analysisId: analysis.id };
  }
}
```

`apps/worker/src/analysis/analysis.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AnalysisSettingsService } from './analysis-settings.service';
import { AnalysisService } from './analysis.service';
import { MatchDispatcher } from './match-dispatcher.service';

@Module({
  providers: [AnalysisSettingsService, MatchDispatcher, AnalysisService],
  exports: [AnalysisSettingsService, MatchDispatcher, AnalysisService],
})
export class AnalysisModule {}
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm build:packages && pnpm --filter @oto/worker test:e2e && pnpm lint && pnpm typecheck`
Expected: PASS. (Prisma'nın çıkarılan tipleri TS2742 verirse dışa açık fonksiyonlara açık dönüş tipi ekle.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add analysis service deriving events from DB state and dispatching match events"
```

---

### Task 5: `analyze` kuyruğu tüketicisi

**Files:**
- Create: `apps/worker/src/processors/analyze-worker.host.ts`
- Modify: `apps/worker/src/config/env.ts`, `apps/worker/src/config/env.spec.ts`, `apps/worker/src/worker-app.module.ts`
- Test: `apps/worker/test/analyze-worker.e2e.spec.ts`

**Interfaces:**
- Consumes: `AnalysisService.process`, `analyzeJobSchema`, `QueueName.ANALYZE`, `bullConnection`, `RETRYING_JOB_OPTS`.
- Produces: `ANALYZE_WORKER_AUTOSTART` token, `AnalyzeWorkerHost` (`start()`, `onModuleDestroy()`); env `ANALYZE_CONCURRENCY` (varsayılan 4, 1–32).

- [ ] **Step 1: Başarısız testleri yaz**

`apps/worker/src/config/env.spec.ts` → defaults testine ekle: `expect(parseEnv(base).ANALYZE_CONCURRENCY).toBe(4);` ve yeni test:
```ts
  it('bounds ANALYZE_CONCURRENCY', () => {
    expect(() => parseEnv({ ...base, ANALYZE_CONCURRENCY: '0' })).toThrow(/ANALYZE_CONCURRENCY/);
    expect(parseEnv({ ...base, ANALYZE_CONCURRENCY: '8' }).ANALYZE_CONCURRENCY).toBe(8);
  });
```

`apps/worker/test/analyze-worker.e2e.spec.ts`:
```ts
import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { PrismaService } from '../src/infra/prisma.service';
import { ANALYZE_WORKER_AUTOSTART, AnalyzeWorkerHost } from '../src/processors/analyze-worker.host';
import { RETRYING_JOB_OPTS } from '../src/queues/job-options';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createContext, createListing, createSource, resetState } from './helpers';

@Module({
  imports: [AnalysisModule],
  providers: [AnalyzeWorkerHost, { provide: ANALYZE_WORKER_AUTOSTART, useValue: false }],
  exports: [AnalyzeWorkerHost],
})
class AnalyzeTestModule {}

let ref: TestingModule;
let prisma: PrismaService;

beforeAll(async () => {
  ref = await createContext([AnalyzeTestModule]);
  prisma = ref.get(PrismaService);
});
afterAll(async () => {
  await ref.get(AnalyzeWorkerHost).onModuleDestroy();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
});

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timed out');
}

describe('AnalyzeWorkerHost', () => {
  it('consumes analyze jobs and produces analyses + match events', async () => {
    const host = ref.get(AnalyzeWorkerHost);
    host.start();
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    for (let i = 0; i < 10; i++) await createListing(ref, sourceId, { price: BigInt(1_195_000 + i * 1000) });
    const t = await createListing(ref, sourceId, { price: 900_000n });
    await ref.get(QueueRegistry).analyze.add('analyze', { listingId: t.id, reason: 'NEW' }, { jobId: `analyze-${t.id}-NEW-test`, ...RETRYING_JOB_OPTS });
    const analyzed = await waitFor(async () => (await prisma.listing.findUnique({ where: { id: t.id } }))?.latestAnalysisId);
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: analyzed } });
    expect(a.matchEvent).toBe('NEW');
    expect(await ref.get(QueueRegistry).match.getJob(`match-${a.id}`)).toBeTruthy();
  });

  it('rejects malformed job data without crashing the worker', async () => {
    ref.get(AnalyzeWorkerHost).start();
    const job = await ref.get(QueueRegistry).analyze.add('analyze', { listingId: -1, reason: 'NEW' } as never, { jobId: 'bad-1', attempts: 1 });
    await waitFor(async () => ((await job.getState()) === 'failed' ? true : null));
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/worker test && pnpm --filter @oto/worker test:e2e`
Expected: FAIL.

- [ ] **Step 3: Uygulamayı yaz**

`apps/worker/src/config/env.ts` → `SCRAPE_CONCURRENCY` satırının altına:
```ts
  ANALYZE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
```
(Şema `superRefine`/`transform` ile sarılmışsa alanı temel nesneye ekle.)

`apps/worker/src/processors/analyze-worker.host.ts`:
```ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { analyzeJobSchema, QueueName, type AnalyzeJobData } from '@oto/shared';
import { Worker } from 'bullmq';
import { AnalysisService } from '../analysis/analysis.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

export const ANALYZE_WORKER_AUTOSTART = Symbol('ANALYZE_WORKER_AUTOSTART');

@Injectable()
export class AnalyzeWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyzeWorkerHost.name);
  private worker?: Worker<AnalyzeJobData>;

  constructor(
    private readonly analysis: AnalysisService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(ANALYZE_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<AnalyzeJobData>(
      QueueName.ANALYZE,
      async (job) => {
        const data = analyzeJobSchema.parse(job.data);
        await this.analysis.process(data.listingId);
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: this.env.ANALYZE_CONCURRENCY },
    );
    this.worker.on('error', (err) => this.logger.error(`Analiz worker hatası: ${err.message}`));
    this.worker.on('failed', (job, err) => this.logger.warn(`Analiz işi ${job?.id} başarısız (deneme ${job?.attemptsMade}): ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
```

`apps/worker/src/worker-app.module.ts` (tamamı):
```ts
import { Module } from '@nestjs/common';
import { AnalysisModule } from './analysis/analysis.module';
import { CollectionModule } from './collection/collection.module';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';
import { AnalyzeWorkerHost } from './processors/analyze-worker.host';
import { ScrapeWorkerHost } from './processors/scrape-worker.host';

@Module({
  imports: [CoreModule, CollectionModule, AnalysisModule],
  providers: [HeartbeatService, ScrapeWorkerHost, AnalyzeWorkerHost],
})
export class WorkerAppModule {}
```

- [ ] **Step 4: Testleri çalıştır**

Run: `pnpm --filter @oto/worker test && pnpm --filter @oto/worker test:e2e && pnpm --filter @oto/worker build && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): consume analyze queue with configurable concurrency"
```

---

### Task 6: Gece yenilemesi ve bekleyen eşleştirme olaylarının yeniden gönderimi

**Files:**
- Create: `apps/worker/src/scheduler/analysis-sweep.service.ts`
- Modify: `apps/worker/src/scheduler/scheduler.module.ts`, `apps/worker/src/scheduler/scheduler-loop.service.ts`, `apps/worker/src/scheduler-app.module.ts`
- Test: `apps/worker/test/analysis-sweep.e2e.spec.ts`

**Interfaces:**
- Consumes: `MatchDispatcher.dispatch`, `QueueRegistry.analyze`, `RETRYING_JOB_OPTS`, `startOfIstanbulDay` (`@oto/shared`).
- Produces: `NIGHTLY_HOUR_ISTANBUL = 3`, `MATCH_REQUEUE_AFTER_MS = 60_000`, `istanbulDayKey(d)`, `istanbulHour(d)`, `AnalysisSweepService.maybeRunNightly(now?) → number`, `.enqueueRefreshAll(dayKey) → number`, `.requeuePendingMatches(now?) → number`.

- [ ] **Step 1: Başarısız testi yaz** (`apps/worker/test/analysis-sweep.e2e.spec.ts`)

```ts
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { PrismaService } from '../src/infra/prisma.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { AnalysisSweepService, istanbulDayKey, istanbulHour } from '../src/scheduler/analysis-sweep.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { createContext, createListing, createSource, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let sweep: AnalysisSweepService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([AnalysisModule, SchedulerModule]);
  prisma = ref.get(PrismaService);
  sweep = ref.get(AnalysisSweepService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

describe('Istanbul time helpers', () => {
  it('derive the local day and hour (UTC+3)', () => {
    expect(istanbulDayKey(new Date('2026-10-11T20:59:00Z'))).toBe('20261011');
    expect(istanbulDayKey(new Date('2026-10-11T21:00:00Z'))).toBe('20261012');
    expect(istanbulHour(new Date('2026-10-11T23:30:00Z'))).toBe(2);
    expect(istanbulHour(new Date('2026-10-12T00:00:00Z'))).toBe(3);
  });
});

describe('AnalysisSweepService.maybeRunNightly', () => {
  it('runs once per Istanbul day after 03:00 and only for ACTIVE listings', async () => {
    const a = await createListing(ref, sourceId);
    await createListing(ref, sourceId, { status: 'REMOVED' });
    const b = await createListing(ref, sourceId);
    expect(await sweep.maybeRunNightly(new Date('2026-10-11T23:30:00Z'))).toBe(0); // 02:30 İstanbul
    expect(await sweep.maybeRunNightly(new Date('2026-10-12T00:10:00Z'))).toBe(2); // 03:10
    expect(await sweep.maybeRunNightly(new Date('2026-10-12T05:00:00Z'))).toBe(0); // aynı gün
    const jobs = await ref.get(QueueRegistry).analyze.getJobs(['waiting']);
    expect(jobs.map((j) => j.id).sort()).toEqual([`analyze-refresh-${a.id}-20261012`, `analyze-refresh-${b.id}-20261012`].sort());
    expect(jobs.every((j) => j.data.reason === 'REFRESH')).toBe(true);
    expect(await sweep.maybeRunNightly(new Date('2026-10-13T00:10:00Z'))).toBe(2); // ertesi gün
  });

  it('pages through large listing sets', async () => {
    const data = Array.from({ length: 1203 }, (_, i) => ({
      sourceId, externalId: `B${i}`, url: `http://x/${i}`, title: `B${i}`, make: 'BMW', model: '3 Serisi', year: 2019, km: 1, fuel: 'GASOLINE' as const, transmission: 'AUTOMATIC' as const, price: 100_000n, contentHash: `b${i}`,
    }));
    await prisma.listing.createMany({ data });
    expect(await sweep.enqueueRefreshAll('20261012')).toBe(1203);
    expect(await ref.get(QueueRegistry).analyze.count()).toBe(1203);
  });
});

describe('AnalysisSweepService.requeuePendingMatches', () => {
  it('re-dispatches match events older than 60 s that were never queued', async () => {
    const l = await createListing(ref, sourceId);
    const base = { listingId: l.id, engineVersion: 'rules-v1', opportunityScore: 50, comparableCount: 5, confidence: 'MEDIUM' as const, explanation: {}, comparableIds: [] };
    const now = new Date();
    const pending = await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'PRICE_DROP', matchPreviousPrice: 1_000_000n, createdAt: new Date(now.getTime() - 120_000) } });
    await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'NEW', createdAt: new Date(now.getTime() - 10_000) } }); // çok yeni
    await prisma.listingAnalysis.create({ data: { ...base, matchEvent: 'NEW', matchQueuedAt: now, createdAt: new Date(now.getTime() - 120_000) } }); // zaten kuyrukta
    await prisma.listingAnalysis.create({ data: { ...base, createdAt: new Date(now.getTime() - 120_000) } }); // olay yok
    expect(await sweep.requeuePendingMatches(now)).toBe(1);
    const job = await ref.get(QueueRegistry).match.getJob(`match-${pending.id}`);
    expect(job?.data).toEqual({ listingId: l.id, analysisId: pending.id, event: 'PRICE_DROP', previousPrice: '1000000' });
    expect((await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: pending.id } })).matchQueuedAt).not.toBeNull();
    expect(await sweep.requeuePendingMatches(now)).toBe(0);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/worker test:e2e`
Expected: FAIL.

- [ ] **Step 3: Uygulamayı yaz**

`apps/worker/src/scheduler/analysis-sweep.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { startOfIstanbulDay } from '@oto/shared';
import { MatchDispatcher } from '../analysis/match-dispatcher.service';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RETRYING_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

export const NIGHTLY_HOUR_ISTANBUL = 3;
export const MATCH_REQUEUE_AFTER_MS = 60_000;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const PAGE = 500;

export function istanbulDayKey(d: Date): string {
  const local = new Date(startOfIstanbulDay(d).getTime() + ISTANBUL_OFFSET_MS);
  return local.toISOString().slice(0, 10).replace(/-/g, '');
}

export function istanbulHour(d: Date): number {
  return (d.getUTCHours() + 3) % 24;
}

@Injectable()
export class AnalysisSweepService {
  private readonly logger = new Logger(AnalysisSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
    private readonly matches: MatchDispatcher,
  ) {}

  /** İstanbul saatiyle 03:00'ten sonra günde bir kez tüm aktif ilanlar için REFRESH işi üretir. */
  async maybeRunNightly(now: Date = new Date()): Promise<number> {
    if (istanbulHour(now) < NIGHTLY_HOUR_ISTANBUL) return 0;
    const dayKey = istanbulDayKey(now);
    const claimed = await this.redis.set(`analysis:nightly:${dayKey}`, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
    if (claimed !== 'OK') return 0;
    const n = await this.enqueueRefreshAll(dayKey);
    this.logger.log(`Gece yeniden analizi: ${n} ilan kuyruğa eklendi (${dayKey})`);
    return n;
  }

  async enqueueRefreshAll(dayKey: string): Promise<number> {
    let cursor = 0;
    let total = 0;
    for (;;) {
      const rows = await this.prisma.listing.findMany({
        where: { status: 'ACTIVE', id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: PAGE,
        select: { id: true },
      });
      if (rows.length === 0) break;
      await this.queues.analyze.addBulk(
        rows.map((r) => ({
          name: 'analyze',
          data: { listingId: r.id, reason: 'REFRESH' as const },
          opts: { jobId: `analyze-refresh-${r.id}-${dayKey}`, ...RETRYING_JOB_OPTS },
        })),
      );
      total += rows.length;
      cursor = rows[rows.length - 1].id;
    }
    return total;
  }

  /** Commit sonrası kuyruğa alınamamış eşleştirme olaylarını yeniden gönderir. */
  async requeuePendingMatches(now: Date = new Date()): Promise<number> {
    const pending = await this.prisma.listingAnalysis.findMany({
      where: { matchEvent: { not: null }, matchQueuedAt: null, createdAt: { lt: new Date(now.getTime() - MATCH_REQUEUE_AFTER_MS) } },
      orderBy: { id: 'asc' },
      take: PAGE,
      select: { id: true, listingId: true, matchEvent: true, matchPreviousPrice: true },
    });
    let sent = 0;
    for (const p of pending) {
      try {
        await this.matches.dispatch({ analysisId: p.id, listingId: p.listingId, event: p.matchEvent!, previousPrice: p.matchPreviousPrice });
        sent += 1;
      } catch (err) {
        this.logger.warn(`Eşleştirme olayı yeniden gönderilemedi (analiz ${p.id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return sent;
  }
}
```

`apps/worker/src/scheduler/scheduler.module.ts` (tamamı):
```ts
import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { AnalysisSweepService } from './analysis-sweep.service';
import { SchedulerService } from './scheduler.service';

@Module({ imports: [AnalysisModule], providers: [SchedulerService, AnalysisSweepService], exports: [SchedulerService, AnalysisSweepService] })
export class SchedulerModule {}
```

`apps/worker/src/scheduler/scheduler-loop.service.ts`: constructor'a `private readonly sweep: AnalysisSweepService` ekle; `safeTick` içinde, `scheduler.tick()` sonrasında (aynı try bloğunda) ekle:
```ts
      await this.sweep.maybeRunNightly();
      const requeued = await this.sweep.requeuePendingMatches();
      if (requeued > 0) this.logger.warn(`${requeued} eşleştirme olayı yeniden kuyruğa alındı`);
```

`apps/worker/src/scheduler-app.module.ts` değişmez (SchedulerModule artık AnalysisModule'ü içe aktarır).

- [ ] **Step 4: Testleri çalıştır**

Run: `pnpm --filter @oto/worker test:e2e && pnpm --filter @oto/worker build && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): add nightly re-analysis sweep and pending match event requeue"
```

---

### Task 7: Uçtan uca hat (tarama → analiz → match), dokümantasyon, smoke test

**Files:**
- Modify: `apps/worker/test/pipeline.e2e.spec.ts`, `.env.example`, `README.md`, `docs/architecture.md`, `docs/superpowers/plans/2026-10-10-00-roadmap.md`
- Create: `docs/analysis-engine.md`

**Interfaces:**
- Consumes: tüm önceki task'lar; `fairPrice`, `CATALOG` (`@oto/demo-site`).

- [ ] **Step 1: Pipeline testini genişlet**

`apps/worker/test/pipeline.e2e.spec.ts`:
- `ProcessorTestModule`'e `AnalysisModule` import'u ve `AnalyzeWorkerHost` + `{ provide: ANALYZE_WORKER_AUTOSTART, useValue: false }` sağlayıcılarını ekle; `createContext([CollectionModule, SchedulerModule, ProcessorTestModule])` aynı kalır; `beforeAll`'da `ref.get(AnalyzeWorkerHost).start()`, `afterAll`'da `onModuleDestroy()`.
- Mevcut senaryodan ayrı, yeni bir `it` ekle:

```ts
  it('analyzes scraped listings and emits a NEW match event for an injected deal', async () => {
    await createAdmin(ref);
    const source = await seedDemoSource(prisma, demo.baseUrl);
    await prisma.dataSource.update({ where: { id: source.id }, data: { minRequestGapMs: 0, intervalSec: 60 } });
    const year = new Date().getFullYear();
    const bmw = CATALOG.find((c) => c.make === 'BMW')!;
    const fair = fairPrice(bmw, year - 2, 40_000, year);
    // Fırsat ilanı ÖNCE eklenir: liste en yeniden eskiye sıralı olduğundan emsaller ondan önce ingest edilir
    // ve fırsatın analizi tam emsal havuzunu görür.
    const deal = demo.site.store.inject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: year - 2, km: 40_000, fuel: 'Benzin', transmission: 'Otomatik', discount: 0.25 });
    for (let i = 0; i < 9; i++) {
      demo.site.store.inject({ make: 'BMW', model: '3 Serisi', trim: '318i', year: year - 2, km: 40_000 + i * 500, fuel: 'Benzin', transmission: 'Otomatik', price: Math.round((fair * (0.97 + i * 0.0075)) / 1000) * 1000 });
    }
    await cycle(new Date());
    const row = await prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId: deal.id } } });
    const deadline = Date.now() + 30_000;
    let analysisId: number | null = null;
    while (Date.now() < deadline && !analysisId) {
      analysisId = (await prisma.listing.findUniqueOrThrow({ where: { id: row.id } })).latestAnalysisId;
      if (!analysisId) await new Promise((r) => setTimeout(r, 200));
    }
    const a = await prisma.listingAnalysis.findUniqueOrThrow({ where: { id: analysisId! } });
    expect(['HIGH', 'MEDIUM']).toContain(a.confidence);
    expect(Number(a.discountPct)).toBeGreaterThan(0.18);
    expect(Number(a.discountPct)).toBeLessThan(0.32);
    expect(a.opportunityScore).toBeGreaterThanOrEqual(60);
    expect(await ref.get(QueueRegistry).match.getJob(`match-${a.id}`)).toBeTruthy();
  });
```
(Gerekli import'lar: `AnalysisModule`, `ANALYZE_WORKER_AUTOSTART`, `AnalyzeWorkerHost`, `CATALOG`, `fairPrice` from `@oto/demo-site`. Bu test kendi `cycle` çağrısında `scheduler.tick(new Date())` kullanır; önceki test aynı dosyada çalışıyorsa `resetState` beforeEach'te state'i temizler, demo store ise `demo.site.store.reset(7, 60)` ile `beforeEach`'te sıfırlanmalıdır — yoksa ekle.)

Run: `pnpm build:packages && pnpm --filter @oto/worker test:e2e` → PASS. (Başarısız olursa önce demo verisini ve emsal havuzunu incele: 9 benzer BMW + fırsat ilanı aynı yakıt/vites/yıl ve ±%25 km içinde olmalı.)

- [ ] **Step 2: Dokümantasyon**

`docs/analysis-engine.md`:
```markdown
# Fırsat analiz motoru (`rules-v1`)

Kod: `packages/analysis` (saf, DB'siz) + `apps/worker/src/analysis` (DB, kuyruk). Ayarlar `SystemSetting` anahtarı `analysis.settings` ile ezilebilir (geçersiz ayar → varsayılanlar + uyarı).

## 1. Emsal havuzu
Aynı marka + model + yakıt + vites; hedef hariç; son 60 günde görülmüş; kaldırılmışsa yalnızca son 60 günde kaldırılmış (son fiyatıyla). Aynı başlık + fiyat + km tek sayılır.

| Seviye | Yıl | Km (× max(hedef km, 10.000)) | Trim | Güven tavanı |
|---|---|---|---|---|
| L0 | ±0 | ±%25 | aynı (hedefte varsa) | HIGH |
| L1 | ±1 | ±%25 | serbest | HIGH |
| L2 | ±2 | ±%40 | serbest | MEDIUM |
| L3 | ±3 | ±%60 | serbest | LOW |

≥ 5 emsalin bulunduğu ilk seviyede durulur. Hedef hasarsızsa (tramer > 0 veya değişen parça yok), yeterli temiz emsal kalıyorsa hasarlı emsaller çıkarılır.

## 2. Düzeltmeler
- Yıl: `(1 + 0,07)^(hedef yılı − emsal yılı)`.
- Km: havuz ≥ 8 ise Theil–Sen eğimi (negatifse), değilse 10.000 km başına %2.
- Yıl + km toplam düzeltmesi emsal fiyatının %80–%120'si ile sınırlanır.

## 3. Tahmin
IQR ile uç değer ayıklama (Q1 − 1,5·IQR, Q3 + 1,5·IQR), kalanların medyanı = tahmin. İndirim = (tahmin − fiyat) / tahmin.

## 4. Güven
Seviye tavanı → 5–7 emsal ise en fazla MEDIUM → IQR/medyan > 0,25 ise bir kademe düş (`HIGH_DISPERSION`) → hedef hasarlıysa bir kademe düş (`DAMAGED`) → indirim > %45 ise en fazla LOW (`SUSPICIOUS_LOW`). L3'te bile < 5 emsal (veya uç değer ayıklaması sonrası < 5) → `INSUFFICIENT`.

## 5. Puan
`round(clamp(indirim / 0,30, 0, 1) × 70 + güven puanı + fiyat düşüşü bonusu)`; güven puanı HIGH 30 / MEDIUM 18 / LOW 6 / INSUFFICIENT 0; bonus 5 (geçmişte fiyat düşüşü varsa ve indirim > 0).

## 6. Örnek
14 emsal (L1, yayılım ~%10), medyan 1.200.000 TL, ilan 960.000 TL → fark 240.000, indirim %20, güven HIGH, puan `round(0,667 × 70 + 30) = 77`.

## 7. Olaylar
Analiz işi verisindeki `reason` yalnızca ipucudur. Olay son analizle karşılaştırılarak türetilir: ilk analiz `NEW`; son analizden sonra yeniden yayın `RELIST`; içerik aynıysa `REFRESH`; fiyat son analiz edilen fiyattan düşükse `PRICE_DROP`; diğer değişiklik `CHANGE`. Yalnızca `NEW`, `PRICE_DROP`, `RELIST` → `match` kuyruğu (`jobId = match-<analysisId>`). `REFRESH` yeni satırı yalnızca tahmin > %2 değiştiğinde (veya güven/sürüm değiştiğinde) yazar ve olay üretmez.

## 8. Açıklanabilirlik
Her `ListingAnalysis.explanation`: seviye, havuz sayıları (aday, tekilleştirme sonrası, seviyede, hasarlı çıkarılan, kullanılan, uç değer id'leri), düzeltme yöntemi ve katsayıları, Q1/medyan/Q3/yayılım, bayraklar ve kullanılan ayarlar. `comparableIds` kullanılan emsallerdir.
```

`docs/architecture.md` sonuna ekle:
```markdown
## Analiz (Plan 03)
- `@oto/analysis` (saf `rules-v1` motoru) + worker `AnalysisModule`. `analyze` kuyruğunu `AnalyzeWorkerHost` tüketir (`ANALYZE_CONCURRENCY`, varsayılan 4); ilan başına Redis kilidi eşzamanlı analizi engeller.
- Olay türetme DB'den: son analizdeki `listingPrice`/`listingContentHash` ile güncel ilan karşılaştırılır. `NEW`/`PRICE_DROP`/`RELIST` → `match` kuyruğu (Plan 04). Kuyruğa alınamayan olaylar scheduler tarafından 60 sn sonra yeniden gönderilir.
- Scheduler İstanbul saatiyle 03:00'ten sonra günde bir kez tüm aktif ilanlar için `REFRESH` işi üretir; bu analizler bildirim üretmez.
```

`.env.example` → "Toplama hattı" bölümüne ekle: `ANALYZE_CONCURRENCY=4`

`README.md` → "Toplama hattını çalıştırma" bölümünün sonuna ekle:
```markdown
Worker aynı süreçte analiz kuyruğunu da tüketir; analiz sonuçları `ListingAnalysis` tablosuna yazılır. Motorun kuralları: [`docs/analysis-engine.md`](docs/analysis-engine.md).
```

`docs/superpowers/plans/2026-10-10-00-roadmap.md` sonuna ekle:
```markdown

## Plan 03 sonrası taşınan maddeler
- **Plan 04:** `match` kuyruğunun tüketicisi; iş verisine değil `ListingAnalysis` + `Listing` güncel durumuna göre eşleştir; `previousPrice` yalnızca PRICE_DROP'ta gelir.
- **Plan 06:** "Bu fiyat nasıl hesaplandı?" paneli `explanation` + `comparableIds`'ten üretilir (docs/analysis-engine.md).
- **Plan 07:** Admin "yeniden analiz et" ve analiz ayarları ekranı (`analysis.settings`); ayar değişiminden sonra `AnalysisSettingsService` önbelleği en geç 60 sn'de yenilenir.
- **Ölçek:** emsal sorgusu ilan başına bir sorgu; binlerce ilanda make/model gruplamalı toplu analiz düşünülmeli.
```

- [ ] **Step 3: Canlı smoke test**

```bash
pnpm db:up && pnpm build:packages && pnpm db:migrate && pnpm db:seed
DEMO_SIZE=400 DEMO_TICK_MS=0 node apps/demo-site/dist/main.js &
pnpm --filter @oto/worker build
SCHEDULER_TICK_MS=2000 node apps/worker/dist/main.js --role=scheduler &
node apps/worker/dist/main.js &
```
~60 sn bekle; sorgula (ör. küçük bir node betiği `@oto/db` PrismaClient ile veya `docker compose -f docker-compose.dev.yml exec postgres psql -U oto -d oto -c ...`):
- `SELECT count(*) FROM "Listing" WHERE "latestAnalysisId" IS NOT NULL;` → ~400
- `SELECT confidence, count(*) FROM "ListingAnalysis" GROUP BY 1;`
- `SELECT count(*) FROM "ListingAnalysis" WHERE "matchEvent"='NEW' AND "matchQueuedAt" IS NOT NULL;`
Süreçleri durdur; gerçek sayıları raporla.

- [ ] **Step 4: Tüm doğrulama**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: Hepsi PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(worker): extend pipeline e2e through analysis; document the analysis engine"
```

---

## Plan Sonu Kontrol Listesi (Spec karşılığı)

| Spec maddesi | Task |
|---|---|
| §4.1 Kademeli emsal havuzu, 60 gün, REMOVED son fiyatla, mükerrer tekilleştirme | 2, 4 |
| §4.2 Yıl/km düzeltmesi (Theil–Sen ≥ 8), ±%20, hasar politikası | 2 |
| §4.3 IQR + medyan tahmin, indirim | 2 |
| §4.4 Güvenilirlik kuralları ve bayraklar | 2 |
| §4.5 Fırsat puanı | 2 |
| §4.6 Açıklanabilirlik (`explanation`, `comparableIds`) | 2, 4, 7 |
| §4.7 Fiyat değişiminde yeniden analiz; gece yenilemesi; %2 kuralı; gece bildirim yok | 4, 6 |
| §4.8 Referans örnek (puan 77) | 2, 4 |
| §1 analyze → match akışı, idempotent aşamalar | 3, 4, 5, 6 |
| §5.1 Olay türleri (NEW/PRICE_DROP/RELIST) | 3, 4 |
| Yol haritası Plan 03 notları (DB durumu, kalıcı değişiklik işareti, latestAnalysisId boş ilanların telafisi) | 3, 4, 6 |
