# Plan 04 — Arama Profilleri + Eşleştirme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kullanıcıların arama profilleri tanımlayabilmesi (CRUD, duraklat/sürdür, önizleme, plan limitleri) ve `match` kuyruğunun tüketilerek her analiz olayının uygun profillerle tek SQL'de eşleştirilip `ListingMatch` kayıtlarının idempotent biçimde üretilmesi; kullanıcının eşleşmelerini `/me/matches` ile görebilmesi.

**Architecture:** Eşleştirme koşulu tek bir yerde, `@oto/db` içindeki `matchPredicate` SQL üreticisinde tanımlanır; iki yönde kullanılır: worker "bu ilana uyan profiller" (profil sütunları × ilan parametreleri), API önizlemesi "bu filtreye uyan ilanlar" (profil parametreleri × ilan sütunları). Worker'da `MatchService` ilan başına Postgres advisory kilidi altında adayları bulur, profil başına nedeni (`NEW`/`PRICE_DROP`/`RELIST`) saf `decideMatchReason` ile belirler ve `INSERT … ON CONFLICT DO NOTHING` ile yazar. API'de `/me/search-profiles` ve `/me/matches` userId kapsamlı repository'ler üzerinden çalışır.

**Tech Stack:** TypeScript, zod, NestJS 11 (api: Express 5; worker: app context), Prisma 6 (`$queryRaw` + `Prisma.sql`), PostgreSQL 16 SQL fonksiyonları, BullMQ 5, ioredis, Vitest + Testcontainers + Supertest.

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md` §2 (Kullanıcı tarafı), §5.1–5.3, §6 (İzolasyon, Kayıt ve şifre), §7 (`/me/search-profiles`, `/me/matches`). Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md` (Plan 04 + "Plan 01/02/03 sonrası taşınan maddeler"). Analiz çıktısının anlamı: `docs/analysis-engine.md`.

## Bu planın kararları (spec'i netleştiren)

| Konu | Karar | Gerekçe |
|---|---|---|
| Tek eşleştirme tanımı | `packages/db/src/matching.ts` → `matchPredicate(profileSide, listingSide)`; worker ve önizleme aynı üreticiyi kullanır; ayrı bir "parite" e2e testi iki yönün aynı sonucu verdiğini kanıtlar | Önizleme ile gerçek bildirim birbirinden sapmaz |
| Metin karşılaştırma | make, model, şehir `fold_tr(x)` ile karşılaştırılır: `lower(translate(x,'İIıĞğÜüŞşÖöÇç','iiiggguussoocc'))` (immutable SQL fonksiyonu) | Postgres `lower()` locale'e bağlıdır; "İstanbul"/"istanbul"/"ISTANBUL" ve "Şahin"/"sahin" eşit sayılır |
| `confidence_rank` | Immutable SQL fonksiyonu `confidence_rank(text)`: INSUFFICIENT 0, LOW 1, MEDIUM 2, HIGH 3 | Spec §5.2 |
| `$damaged` | Analiz bayraklarından: `'DAMAGED' = ANY(analysis.flags)` | Motorun hasar tanımıyla aynı (Plan 03 kararı) |
| Eşleştirme fiyatı | `analysis.listingPrice ?? listing.price` (analiz anındaki fiyat) | Olay hangi fiyattan doğduysa o fiyattan eşleşir |
| Profil başına neden | `decideMatchReason(event, profile, lastMatchedPrice, price)`: profile bu ilan için hiç eşleşme yoksa **her olayda `NEW`**; `RELIST` olayı ve `notifyOnRelist` → `RELIST`; `notifyOnPriceDrop` ve fiyat son eşleşme fiyatından ≥ `priceDropPct` düşük → `PRICE_DROP`; aksi halde yok | Spec §5.1 ("daha önce bildirilmemiş ilan … NEW gibi"); Plan 03 yükseltme-NEW'i idempotent olur; düşük fiyatlı RELIST, PRICE_DROP profillerini de besler (yol haritası sorusu) |
| Yinelenen / sırasız işler | İlan başına `pg_advisory_xact_lock(4242, listingId)` + `ListingMatch` benzersiz anahtarı + "son eşleşme" kontrolü | Aynı ilan için eşzamanlı iki iş tek eşleşme üretir; PRICE_DROP NEW'den önce işlenirse sonra gelen NEW tekrar bildirmez |
| Pasif ilan | İlan `REMOVED` ise eşleştirme yapılmaz (`SKIPPED`) | Kaldırılmış ilan için bildirim anlamsız |
| Profil limiti | Toplam profil sayısı (ACTIVE+PAUSED) < `maxSearchProfiles`; doğrulanmamış e-posta → en fazla 1. Oluşturma kullanıcı başına advisory kilit altında sayılır. Sürdürme (`resume`) ACTIVE sayısı < limit ister | Spec §6, §2; yarışta limit aşılmaz; plan düşürülünce fazlası çalışmaz |
| Etkin limitler | `effectiveLimits(plan.limits, sub.limitOverrides)`; aktif abonelik yoksa (veya `endsAt` geçmişse) FREE planı | Spec §2 `limitOverrides` |
| Kanallar | Profil kanalları ⊆ {IN_APP, TELEGRAM} ∩ plan kanalları; `IN_APP` daima eklenir. EMAIL ilan bildirimi MVP'de kapalı → şemada reddedilir | Spec §2, §5.4 |
| Günlük bildirim limiti | Plan 05'e (bildirim oluşturulan yer) taşınır | Sayaç bildirim üretimiyle aynı yerde olmalı |
| Para / oran JSON biçimi | `priceMin`, `priceMax`, `price`, `matchedPrice`, `estimatedPrice` rakam dizgisi; `minDiscountPct`, `priceDropPct`, `discountPct` sayı (kesir, ≤4 ondalık) | Spec §7 "para tam sayı TL, JSON'da string" |
| `/me/matches` sıralama | Yalnızca en yeni önce (id azalan), cursor = son id. `confidence` filtresi "en az bu güven" | YAGNI; skor sıralaması Plan 06 ihtiyaç duyarsa eklenir |
| Yeni externalId ile yeniden yayın | Ingest: externalId bilinmiyorsa, aynı kaynakta son 7 günde `REMOVED` olmuş, aynı başlık + km + yıl'a sahip ilan varsa onun externalId'si yenisiyle değiştirilir ve RELIST yolu izlenir | Spec §5.1; yol haritası Plan 02 notu |

## Global Constraints

- Plan 01, 02 ve 03 Global Constraints maddeleri geçerlidir.
- API: base `/api/v1`; JSON camelCase; tarihler ISO-8601 UTC; para tam sayı TL, JSON'da string. Liste: cursor `{ items, nextCursor }`. Sayfalama limiti ≤ 100. Hata: `{ error: { code, message, details? } }`, kodlar `packages/shared/src/errors.ts`.
- Global zod validasyon; şemalar `packages/shared`; bilinmeyen alanlar reddedilir (`.strict()`).
- İzolasyon: `apps/api/src/modules/me/**` altında veri erişimi yalnızca `*.repository.ts` üzerinden ve her sorgu `userId` ile kapsamlı; yabancı kaynak → **404**. Her yeni `/me` route'u `apps/api/test/isolation.e2e.spec.ts` `CASES` tablosuna eklenmelidir (aksi halde kapsama testi düşer).
- Eşleştirme sorgusu yalnızca `SearchProfile.status='ACTIVE'` ve `User.status='ACTIVE'` profilleri döndürür.
- `minDiscountPct = 0` olan profillerde güven koşulu uygulanmaz ("yeni ilan takibi"); `> 0` ise ilan `INSUFFICIENT` olmamalı, `discountPct ≥ minDiscountPct` ve `confidence_rank(ilan) ≥ confidence_rank(profil.minConfidence)`.
- `ListingMatch` unique(searchProfileId, listingId, reason, matchedPrice); ekleme `ON CONFLICT DO NOTHING`.
- BullMQ job id'leri `:` içermez; yeniden denenen işler `RETRYING_JOB_OPTS`; bozuk payload `UnrecoverableError`.
- Kaynak etiği: hiçbir değişiklik scraping kısıtlarını aşma davranışı eklemez.

## Review Focus

1. **Türkçe büyük/küçük harf (İstanbul / istanbul / ISTANBUL, Şahin / sahin):** Aynı şehir/marka eşleşmeli. → Task 2 parite testi.
2. **Yalnızca "yeni ilan takibi" profili (`minDiscountPct = 0`) ve `INSUFFICIENT` ilan:** Eşleşmeli; `minDiscountPct > 0` profil eşleşmemeli. → Task 2 testi.
3. **Aynı ilan için yinelenen/eşzamanlı `match` işleri:** Profil başına tek `ListingMatch`. → Task 3 testi.
4. **Limitte iki paralel profil oluşturma isteği:** Biri 201, diğeri 403 `LIMIT_REACHED`; DB'de limit kadar profil. → Task 5 testi.
5. **Sırasız olaylar (PRICE_DROP işi NEW işinden önce işlenir):** Profil bir kez `NEW` alır; sonra gelen eski `NEW` tekrar eşleşme üretmez. → Task 3 testi.

## Dosya Haritası

```
packages/shared/src/  schemas/search-profile.ts (+ schemas.spec.ts eklemeleri), errors.ts (LIMIT_REACHED), plan.ts (effectiveLimits), index.ts
packages/db/          prisma/migrations/20261013000000_matching_functions/, src/matching.ts, src/index.ts, test/matching.spec.ts
packages/db/          prisma/schema.prisma (+ Listing relist indeksi), migrations/20261013000001_relist_index/
apps/worker/src/matching/  {decide.ts, decide.spec.ts, match.service.ts, matching.module.ts}
apps/worker/src/processors/ match-worker.host.ts
apps/worker/src/config/env.ts (MATCH_CONCURRENCY), worker-app.module.ts
apps/worker/src/collection/ingest.service.ts (yeniden yayın ikizi)
apps/worker/test/  match.e2e.spec.ts, match-worker.e2e.spec.ts, ingest.e2e.spec.ts (ekleme), pipeline.e2e.spec.ts (ekleme), helpers.ts (createProfile, createAnalysis)
apps/api/src/modules/me/  limits.service.ts, search-profiles.{repository,service,controller}.ts, search-profile.view.ts,
                          matches.{repository,controller}.ts, me.module.ts, me.service.ts, me.repository.ts
apps/api/src/modules/auth/ password-confirmation.service.ts, email-verification.service.ts, auth.controller.ts, auth.module.ts
apps/api/test/  search-profiles.e2e.spec.ts, matches.e2e.spec.ts, isolation.e2e.spec.ts, auth-carryover.e2e.spec.ts, lint/me-prisma-rule.spec.ts, helpers.ts
eslint.config.mjs (me kuralı sertleştirme)
docs/  matching.md (yeni), architecture.md, README.md, .env.example, superpowers/plans/2026-10-10-00-roadmap.md
```

---

### Task 1: Paylaşılan sözleşmeler (profil şemaları, limitler, hata kodu)

**Files:**
- Create: `packages/shared/src/schemas/search-profile.ts`
- Modify: `packages/shared/src/errors.ts`, `packages/shared/src/plan.ts`, `packages/shared/src/index.ts`, `packages/shared/src/schemas.spec.ts`, `packages/shared/src/queues.spec.ts`

**Interfaces:**
- Produces:
  - `FUELS`, `TRANSMISSIONS`, `CONFIDENCES` (`['INSUFFICIENT','LOW','MEDIUM','HIGH']`), `MATCH_REASONS`, `PROFILE_CHANNELS` (`['IN_APP','TELEGRAM']`) — `as const` diziler; tipler `Fuel`, `Transmission`, `ConfidenceLevel`, `MatchReasonValue`, `ProfileChannel`.
  - `searchProfileFieldsSchema` (strict object), `createSearchProfileSchema`, `updateSearchProfileSchema`, `previewSearchProfileSchema`, `listMatchesQuerySchema`; tipler `CreateSearchProfileInput`, `UpdateSearchProfileInput`, `PreviewSearchProfileInput`, `ListMatchesQuery`.
  - `withProfileDefaults(input: CreateSearchProfileInput): NormalizedProfile` — tüm alanlar dolu, `channels` IN_APP içerir ve tekil, `cities` trim + tekil.
  - `confidenceAtLeast(c: ConfidenceLevel): ConfidenceLevel[]`.
  - `ErrorCode.LIMIT_REACHED`.
  - `limitOverridesSchema`, `effectiveLimits(limits: PlanLimits, overrides: unknown): PlanLimits`.

- [ ] **Step 1: Başarısız testleri yaz**

`packages/shared/src/schemas.spec.ts` sonuna ekle:

```ts
import {
  confidenceAtLeast,
  createSearchProfileSchema,
  effectiveLimits,
  listMatchesQuerySchema,
  previewSearchProfileSchema,
  updateSearchProfileSchema,
  withProfileDefaults,
} from './index';

describe('search profile schemas', () => {
  const base = { name: 'BMW fırsat' };

  it('accepts a minimal profile and applies defaults', () => {
    const p = withProfileDefaults(createSearchProfileSchema.parse(base));
    expect(p).toMatchObject({
      name: 'BMW fırsat', make: null, model: null, yearMin: null, priceMin: null, fuels: [], cities: [],
      minDiscountPct: 0, minConfidence: 'MEDIUM', excludeDamaged: false, notifyOnPriceDrop: true,
      priceDropPct: 0.05, notifyOnRelist: false, channels: ['IN_APP'],
    });
  });

  it('always includes IN_APP once and dedupes cities', () => {
    const p = withProfileDefaults(createSearchProfileSchema.parse({ ...base, channels: ['TELEGRAM', 'TELEGRAM'], cities: [' İstanbul ', 'İstanbul', 'Ankara'] }));
    expect(p.channels).toEqual(['IN_APP', 'TELEGRAM']);
    expect(p.cities).toEqual(['İstanbul', 'Ankara']);
  });

  it('rejects EMAIL channel, unknown fields, bad money and >4 decimals', () => {
    expect(createSearchProfileSchema.safeParse({ ...base, channels: ['EMAIL'] }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, foo: 1 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMax: 1000 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMax: '-5' }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, minDiscountPct: 0.12345 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, minDiscountPct: 0.95 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceDropPct: 0 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, minConfidence: 'INSUFFICIENT' }).success).toBe(false);
  });

  it('enforces cross-field consistency', () => {
    expect(createSearchProfileSchema.safeParse({ ...base, model: '3 Serisi' }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, yearMin: 2020, yearMax: 2018 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMin: '900000', priceMax: '100000' }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMin: '99', priceMax: '100' }).success).toBe(true);
  });

  it('update requires at least one field and stays strict', () => {
    expect(updateSearchProfileSchema.safeParse({}).success).toBe(false);
    expect(updateSearchProfileSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(updateSearchProfileSchema.safeParse({ userId: 'x' }).success).toBe(false);
  });

  it('preview accepts only filter fields', () => {
    expect(previewSearchProfileSchema.safeParse({ make: 'BMW', minDiscountPct: 0.1 }).success).toBe(true);
    expect(previewSearchProfileSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('list matches query coerces and bounds', () => {
    expect(listMatchesQuerySchema.parse({ limit: '50', minScore: '60', cursor: '10' })).toMatchObject({ limit: 50, minScore: 60, cursor: 10 });
    expect(listMatchesQuerySchema.parse({}).limit).toBe(20);
    expect(listMatchesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listMatchesQuerySchema.safeParse({ sort: 'score' }).success).toBe(false);
  });

  it('confidenceAtLeast', () => {
    expect(confidenceAtLeast('MEDIUM')).toEqual(['MEDIUM', 'HIGH']);
    expect(confidenceAtLeast('INSUFFICIENT')).toEqual(['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH']);
  });
});

describe('effectiveLimits', () => {
  const plan = { maxSearchProfiles: 2, maxNotificationsPerDay: 20, channels: ['IN_APP', 'TELEGRAM'] as ('IN_APP' | 'TELEGRAM' | 'EMAIL')[], opportunitiesDelayHours: 0 };
  it('applies valid overrides and ignores invalid ones', () => {
    expect(effectiveLimits(plan, { maxSearchProfiles: 5 }).maxSearchProfiles).toBe(5);
    expect(effectiveLimits(plan, null)).toEqual(plan);
    expect(effectiveLimits(plan, { maxSearchProfiles: -1 })).toEqual(plan);
    expect(effectiveLimits(plan, 'garbage')).toEqual(plan);
  });
});
```

`packages/shared/src/queues.spec.ts` sonuna (Plan 03 taşınan madde) ekle:

```ts
describe('matchJobSchema negative cases', () => {
  it('rejects numeric previousPrice and non-positive ids', () => {
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 1, event: 'PRICE_DROP', previousPrice: 1000 }).success).toBe(false);
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 0, event: 'NEW' }).success).toBe(false);
    expect(matchJobSchema.safeParse({ listingId: -1, analysisId: 1, event: 'NEW' }).success).toBe(false);
    expect(matchJobSchema.safeParse({ listingId: 1, analysisId: 1, event: 'REFRESH' }).success).toBe(false);
  });
});
```
(`matchJobSchema` import'u dosyada yoksa ekle.)

- [ ] **Step 2: Testlerin başarısız olduğunu doğrula**

Run: `pnpm --filter @oto/shared test`
Expected: FAIL — `createSearchProfileSchema` vb. export edilmiyor.

- [ ] **Step 3: Uygula**

`packages/shared/src/errors.ts` → `ErrorCode` içine `INVALID_OPERATION`'dan önce: `LIMIT_REACHED: 'LIMIT_REACHED',`

`packages/shared/src/plan.ts` sonuna:

```ts
export const limitOverridesSchema = planLimitsSchema.partial();

/** Plan limitlerine kullanıcıya özel geçersiz kılmaları uygular; geçersiz kılma bozuksa plan limitleri aynen döner. */
export function effectiveLimits(limits: PlanLimits, overrides: unknown): PlanLimits {
  if (overrides === null || overrides === undefined) return limits;
  const parsed = limitOverridesSchema.safeParse(overrides);
  if (!parsed.success) return limits;
  return { ...limits, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
}
```

`packages/shared/src/schemas/search-profile.ts`:

```ts
import { z } from 'zod';

export const FUELS = ['GASOLINE', 'DIESEL', 'LPG', 'HYBRID', 'ELECTRIC', 'OTHER'] as const;
export const TRANSMISSIONS = ['MANUAL', 'AUTOMATIC', 'SEMI_AUTOMATIC'] as const;
export const CONFIDENCES = ['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH'] as const;
export const MATCH_REASONS = ['NEW', 'PRICE_DROP', 'RELIST'] as const;
/** İlan bildirimi kanalları. EMAIL ilan bildirimi MVP'de kapalıdır (spec §5.4). */
export const PROFILE_CHANNELS = ['IN_APP', 'TELEGRAM'] as const;

export type Fuel = (typeof FUELS)[number];
export type Transmission = (typeof TRANSMISSIONS)[number];
export type ConfidenceLevel = (typeof CONFIDENCES)[number];
export type MatchReasonValue = (typeof MATCH_REASONS)[number];
export type ProfileChannel = (typeof PROFILE_CHANNELS)[number];

export function confidenceAtLeast(c: ConfidenceLevel): ConfidenceLevel[] {
  return CONFIDENCES.slice(CONFIDENCES.indexOf(c));
}

const money = z.string().regex(/^\d{1,12}$/, 'TL tam sayı (rakam dizgisi) olmalı');
const text = (max: number) => z.string().trim().min(1).max(max);
const year = z.number().int().min(1950).max(2100);
const fraction = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((v) => Math.abs(Math.round(v * 10_000) - v * 10_000) < 1e-6, 'en fazla 4 ondalık basamak');

export const searchProfileFieldsSchema = z
  .object({
    name: text(60),
    make: text(40).nullable().optional(),
    model: text(60).nullable().optional(),
    yearMin: year.nullable().optional(),
    yearMax: year.nullable().optional(),
    priceMin: money.nullable().optional(),
    priceMax: money.nullable().optional(),
    kmMax: z.number().int().min(0).max(2_000_000).nullable().optional(),
    fuels: z.array(z.enum(FUELS)).max(FUELS.length).optional(),
    transmissions: z.array(z.enum(TRANSMISSIONS)).max(TRANSMISSIONS.length).optional(),
    cities: z.array(text(40)).max(20).optional(),
    minDiscountPct: fraction(0, 0.9).optional(),
    minConfidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    excludeDamaged: z.boolean().optional(),
    notifyOnPriceDrop: z.boolean().optional(),
    priceDropPct: fraction(0.01, 0.5).optional(),
    notifyOnRelist: z.boolean().optional(),
    channels: z.array(z.enum(PROFILE_CHANNELS)).max(PROFILE_CHANNELS.length).optional(),
  })
  .strict();

type ConsistencyFields = Partial<
  Pick<z.infer<typeof searchProfileFieldsSchema>, 'make' | 'model' | 'yearMin' | 'yearMax' | 'priceMin' | 'priceMax'>
>;

/** Alanlar arası tutarlılık; oluşturma, güncelleme sonrası birleşik kayıt ve önizleme için ortak. */
export function checkProfileConsistency(v: ConsistencyFields, ctx: z.RefinementCtx): void {
  if (v.model && !v.make) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model için marka seçilmelidir' });
  if (v.yearMin != null && v.yearMax != null && v.yearMin > v.yearMax)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['yearMax'], message: 'yearMax, yearMin değerinden küçük olamaz' });
  if (v.priceMin != null && v.priceMax != null && BigInt(v.priceMin) > BigInt(v.priceMax))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMax'], message: 'priceMax, priceMin değerinden küçük olamaz' });
}

export const createSearchProfileSchema = searchProfileFieldsSchema.superRefine(checkProfileConsistency);
export type CreateSearchProfileInput = z.infer<typeof createSearchProfileSchema>;

export const updateSearchProfileSchema = searchProfileFieldsSchema
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'En az bir alan gönderilmelidir');
export type UpdateSearchProfileInput = z.infer<typeof updateSearchProfileSchema>;

export const previewSearchProfileSchema = searchProfileFieldsSchema
  .pick({
    make: true, model: true, yearMin: true, yearMax: true, priceMin: true, priceMax: true, kmMax: true,
    fuels: true, transmissions: true, cities: true, minDiscountPct: true, minConfidence: true, excludeDamaged: true,
  })
  .strict()
  .superRefine(checkProfileConsistency);
export type PreviewSearchProfileInput = z.infer<typeof previewSearchProfileSchema>;

export interface NormalizedProfile {
  name: string;
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  priceMin: string | null;
  priceMax: string | null;
  kmMax: number | null;
  fuels: Fuel[];
  transmissions: Transmission[];
  cities: string[];
  minDiscountPct: number;
  minConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  excludeDamaged: boolean;
  notifyOnPriceDrop: boolean;
  priceDropPct: number;
  notifyOnRelist: boolean;
  channels: ProfileChannel[];
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Varsayılanlar DB varsayılanlarıyla aynıdır (schema.prisma SearchProfile). */
export function withProfileDefaults(i: CreateSearchProfileInput): NormalizedProfile {
  return {
    name: i.name,
    make: i.make ?? null,
    model: i.model ?? null,
    yearMin: i.yearMin ?? null,
    yearMax: i.yearMax ?? null,
    priceMin: i.priceMin ?? null,
    priceMax: i.priceMax ?? null,
    kmMax: i.kmMax ?? null,
    fuels: uniq(i.fuels ?? []),
    transmissions: uniq(i.transmissions ?? []),
    cities: uniq(i.cities ?? []),
    minDiscountPct: i.minDiscountPct ?? 0,
    minConfidence: i.minConfidence ?? 'MEDIUM',
    excludeDamaged: i.excludeDamaged ?? false,
    notifyOnPriceDrop: i.notifyOnPriceDrop ?? true,
    priceDropPct: i.priceDropPct ?? 0.05,
    notifyOnRelist: i.notifyOnRelist ?? false,
    channels: uniq<ProfileChannel>(['IN_APP', ...(i.channels ?? [])]),
  };
}

export const listMatchesQuerySchema = z
  .object({
    profileId: z.string().min(1).max(40).optional(),
    reason: z.enum(MATCH_REASONS).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListMatchesQuery = z.infer<typeof listMatchesQuerySchema>;
```

`packages/shared/src/index.ts` → `export * from './schemas/search-profile';` ekle.

- [ ] **Step 4: Testleri ve derlemeyi çalıştır**

Run: `pnpm --filter @oto/shared test && pnpm --filter @oto/shared build`
Expected: PASS. (`@oto/shared` diğer paketlerce `dist` üzerinden tüketilir; build şart.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add search profile, match query schemas, LIMIT_REACHED and effective plan limits"
```

---

### Task 2: Tek eşleştirme koşulu (`@oto/db` matching) + SQL fonksiyonları

**Files:**
- Create: `packages/db/prisma/migrations/20261013000000_matching_functions/migration.sql`, `packages/db/src/matching.ts`, `packages/db/test/matching.spec.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Prisma şeması (değişmez).
- Produces (`@oto/db`):
  - `interface MatchFilter { make: string|null; model: string|null; yearMin: number|null; yearMax: number|null; priceMin: bigint|null; priceMax: bigint|null; kmMax: number|null; fuels: string[]; transmissions: string[]; cities: string[]; excludeDamaged: boolean; minDiscountPct: number; minConfidence: string }`
  - `interface ListingFacts { make: string; model: string; year: number; km: number; price: bigint; fuel: string; transmission: string; city: string|null; damaged: boolean; confidence: string; discountPct: number|null }`
  - `interface MatchingProfileRow { id: string; userId: string; notifyOnPriceDrop: boolean; priceDropPct: Prisma.Decimal; notifyOnRelist: boolean; lastMatchedPrice: bigint|null }`
  - `type RawDb = { $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T> }` (PrismaClient ve transaction client'ı uyar)
  - `findMatchingProfiles(db: RawDb, facts: ListingFacts, listingId: number): Promise<MatchingProfileRow[]>`
  - `interface PreviewListingRow { id: number; title: string; make: string; model: string; year: number; km: number; city: string|null; price: bigint; imageUrl: string|null; url: string; firstSeenAt: Date; opportunityScore: number; confidence: string; discountPct: Prisma.Decimal|null; estimatedPrice: bigint|null }`
  - `previewListings(db: RawDb, filter: MatchFilter, limit: number): Promise<PreviewListingRow[]>` — ACTIVE ilanlar, en yeni `firstSeenAt` önce.
  - `countPreviewSince(db: RawDb, filter: MatchFilter, since: Date): Promise<number>`

- [ ] **Step 1: Başarısız testi yaz**

`packages/db/test/matching.spec.ts` (kendi Postgres container'ını açar, `schema.spec.ts` ile aynı desen):

```ts
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countPreviewSince, findMatchingProfiles, previewListings, type ListingFacts, type MatchFilter } from '../src/matching';

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let sourceId: number;
let seq = 0;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = pg.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "ListingMatch","ListingAnalysis","Listing","SearchProfile","User","DataSource" RESTART IDENTITY CASCADE');
  sourceId = (await prisma.dataSource.create({ data: { code: 'src', name: 'S', adapterKey: 'demo', kind: 'HTTP', permissionType: 'TEST' } })).id;
});

const FILTER: MatchFilter = {
  make: null, model: null, yearMin: null, yearMax: null, priceMin: null, priceMax: null, kmMax: null,
  fuels: [], transmissions: [], cities: [], excludeDamaged: false, minDiscountPct: 0, minConfidence: 'MEDIUM',
};
const FACTS: ListingFacts = {
  make: 'BMW', model: '3 Serisi', year: 2019, km: 85_000, price: 960_000n, fuel: 'GASOLINE', transmission: 'AUTOMATIC',
  city: 'İstanbul', damaged: false, confidence: 'HIGH', discountPct: 0.2,
};

async function user(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  seq += 1;
  return prisma.user.create({ data: { email: `u${seq}@t.com`, passwordHash: 'x', name: 'U', status } });
}
async function profile(over: Partial<MatchFilter> & { status?: 'ACTIVE' | 'PAUSED'; userStatus?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const { status, userStatus, ...f } = over;
  const u = await user(userStatus);
  const m = { ...FILTER, ...f };
  return prisma.searchProfile.create({
    data: {
      userId: u.id, name: 'p', status: status ?? 'ACTIVE', make: m.make, model: m.model, yearMin: m.yearMin, yearMax: m.yearMax,
      priceMin: m.priceMin, priceMax: m.priceMax, kmMax: m.kmMax, fuels: m.fuels as never, transmissions: m.transmissions as never,
      cities: m.cities, excludeDamaged: m.excludeDamaged, minDiscountPct: m.minDiscountPct, minConfidence: m.minConfidence as never,
      channels: ['IN_APP'],
    },
  });
}
async function listingWithAnalysis(f: ListingFacts) {
  seq += 1;
  const l = await prisma.listing.create({
    data: {
      sourceId, externalId: `E${seq}`, url: `http://x/${seq}`, title: `İlan ${seq}`, make: f.make, model: f.model, year: f.year, km: f.km,
      fuel: f.fuel as never, transmission: f.transmission as never, city: f.city, price: f.price, contentHash: `h${seq}`,
    },
  });
  const a = await prisma.listingAnalysis.create({
    data: {
      listingId: l.id, engineVersion: 'rules-v1', estimatedPrice: 1_200_000n, discountPct: f.discountPct, opportunityScore: 77,
      comparableCount: 14, confidence: f.confidence as never, flags: f.damaged ? ['DAMAGED'] : [], explanation: {}, comparableIds: [],
      listingPrice: f.price,
    },
  });
  await prisma.listing.update({ where: { id: l.id }, data: { latestAnalysisId: a.id } });
  return l;
}

/** Her profil için iki yön aynı cevabı vermeli: profil ∈ findMatchingProfiles(ilan) ⟺ ilan ∈ previewListings(profil). */
async function expectParity(f: ListingFacts, filters: Partial<MatchFilter>[], expected: boolean[]) {
  const l = await listingWithAnalysis(f);
  const profiles = [];
  for (const over of filters) profiles.push(await profile(over));
  const forward = new Set((await findMatchingProfiles(prisma, f, l.id)).map((r) => r.id));
  for (let i = 0; i < filters.length; i++) {
    const backward = (await previewListings(prisma, { ...FILTER, ...filters[i] }, 100)).some((r) => r.id === l.id);
    expect({ i, forward: forward.has(profiles[i].id) }).toEqual({ i, forward: expected[i] });
    expect({ i, backward }).toEqual({ i, backward: expected[i] });
  }
}

describe('matching predicate', () => {
  it('basic field filters (parity)', async () => {
    await expectParity(FACTS, [
      {}, { make: 'BMW' }, { make: 'Audi' }, { make: 'BMW', model: '3 Serisi' }, { make: 'BMW', model: '5 Serisi' },
      { yearMin: 2019, yearMax: 2019 }, { yearMin: 2020 }, { yearMax: 2018 },
      { priceMin: 960_000n, priceMax: 960_000n }, { priceMax: 959_999n }, { priceMin: 960_001n },
      { kmMax: 85_000 }, { kmMax: 84_999 },
      { fuels: ['GASOLINE', 'DIESEL'] }, { fuels: ['DIESEL'] },
      { transmissions: ['AUTOMATIC'] }, { transmissions: ['MANUAL'] },
    ], [true, true, false, true, false, true, false, false, true, false, false, true, false, true, false, true, false]);
  });

  it('Turkish case folding for make, model and city (parity)', async () => {
    await expectParity({ ...FACTS, make: 'Şahin', model: 'Doğan SLX', city: 'İstanbul' }, [
      { make: 'sahin' }, { make: 'ŞAHİN', model: 'dogan slx' }, { cities: ['istanbul'] }, { cities: ['ISTANBUL'] }, { cities: ['Ankara'] },
    ], [true, true, true, true, false]);
  });

  it('city filter excludes listings without a city', async () => {
    await expectParity({ ...FACTS, city: null }, [{}, { cities: ['İstanbul'] }], [true, false]);
  });

  it('damage exclusion uses analysis flags', async () => {
    await expectParity({ ...FACTS, damaged: true }, [{}, { excludeDamaged: true }], [true, false]);
  });

  it('minDiscountPct=0 matches INSUFFICIENT; >0 requires confidence and discount', async () => {
    await expectParity({ ...FACTS, confidence: 'INSUFFICIENT', discountPct: 0.3 }, [
      { minDiscountPct: 0 }, { minDiscountPct: 0.1, minConfidence: 'LOW' },
    ], [true, false]);
    await expectParity({ ...FACTS, confidence: 'MEDIUM', discountPct: 0.15 }, [
      { minDiscountPct: 0.15, minConfidence: 'MEDIUM' }, { minDiscountPct: 0.16, minConfidence: 'LOW' }, { minDiscountPct: 0.1, minConfidence: 'HIGH' },
    ], [true, false, false]);
    await expectParity({ ...FACTS, confidence: 'HIGH', discountPct: null }, [{ minDiscountPct: 0.01, minConfidence: 'LOW' }], [false]);
  });

  it('excludes paused profiles and inactive users; returns lastMatchedPrice', async () => {
    const l = await listingWithAnalysis(FACTS);
    const paused = await profile({ status: 'PAUSED' });
    const suspended = await profile({ userStatus: 'SUSPENDED' });
    const ok = await profile();
    const a = await prisma.listingAnalysis.findFirstOrThrow({ where: { listingId: l.id } });
    await prisma.listingMatch.create({ data: { userId: ok.userId, searchProfileId: ok.id, listingId: l.id, analysisId: a.id, reason: 'NEW', matchedPrice: 1_000_000n } });
    await prisma.listingMatch.create({ data: { userId: ok.userId, searchProfileId: ok.id, listingId: l.id, analysisId: a.id, reason: 'PRICE_DROP', matchedPrice: 970_000n } });
    const rows = await findMatchingProfiles(prisma, FACTS, l.id);
    expect(rows.map((r) => r.id)).toEqual([ok.id]);
    expect(rows[0].lastMatchedPrice).toBe(970_000n);
    expect([paused.id, suspended.id].some((id) => rows.some((r) => r.id === id))).toBe(false);
  });

  it('preview ignores REMOVED listings, orders newest first and counts since', async () => {
    const old = await listingWithAnalysis(FACTS);
    await prisma.listing.update({ where: { id: old.id }, data: { firstSeenAt: new Date(Date.now() - 10 * 86_400_000) } });
    const fresh = await listingWithAnalysis(FACTS);
    const removed = await listingWithAnalysis(FACTS);
    await prisma.listing.update({ where: { id: removed.id }, data: { status: 'REMOVED' } });
    const rows = await previewListings(prisma, FILTER, 10);
    expect(rows.map((r) => r.id)).toEqual([fresh.id, old.id]);
    expect(typeof rows[0].price).toBe('bigint');
    expect(await countPreviewSince(prisma, FILTER, new Date(Date.now() - 7 * 86_400_000))).toBe(1);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu doğrula**

Run: `pnpm --filter @oto/db exec vitest run test/matching.spec.ts`
Expected: FAIL — `../src/matching` bulunamıyor.

- [ ] **Step 3: Migration ve modülü yaz**

`packages/db/prisma/migrations/20261013000000_matching_functions/migration.sql`:

```sql
-- Eşleştirme yardımcıları (spec §5.2). IMMUTABLE: indeks ve planlayıcı dostu.
CREATE OR REPLACE FUNCTION confidence_rank(c text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE c WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END
$$;

-- Türkçe harfleri ASCII'ye katlar, sonra küçültür: locale'den bağımsız karşılaştırma.
CREATE OR REPLACE FUNCTION fold_tr(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(t, 'İIıĞğÜüŞşÖöÇç', 'iiiggguussoocc'))
$$;
```

`packages/db/src/matching.ts`:

```ts
import { Prisma } from '@prisma/client';

export interface MatchFilter {
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  priceMin: bigint | null;
  priceMax: bigint | null;
  kmMax: number | null;
  fuels: string[];
  transmissions: string[];
  cities: string[];
  excludeDamaged: boolean;
  minDiscountPct: number;
  minConfidence: string;
}

export interface ListingFacts {
  make: string;
  model: string;
  year: number;
  km: number;
  price: bigint;
  fuel: string;
  transmission: string;
  city: string | null;
  damaged: boolean;
  confidence: string;
  discountPct: number | null;
}

export type RawDb = { $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T> };

type Side<K extends string> = Record<K, Prisma.Sql>;
type ProfileSide = Side<
  'make' | 'model' | 'yearMin' | 'yearMax' | 'priceMin' | 'priceMax' | 'kmMax' | 'fuels' | 'transmissions' | 'cities'
  | 'excludeDamaged' | 'minDiscountPct' | 'minConfidence'
>;
type ListingSide = Side<
  'make' | 'model' | 'year' | 'km' | 'price' | 'fuel' | 'transmission' | 'city' | 'damaged' | 'confidence' | 'discountPct'
>;

/** Spec §5.2 eşleştirme koşulu. TEK tanım: iki yön de bunu kullanır. */
function matchPredicate(p: ProfileSide, l: ListingSide): Prisma.Sql {
  return Prisma.sql`(
        (${p.make} IS NULL OR fold_tr(${p.make}) = fold_tr(${l.make}))
    AND (${p.model} IS NULL OR fold_tr(${p.model}) = fold_tr(${l.model}))
    AND (${p.yearMin} IS NULL OR ${l.year} >= ${p.yearMin})
    AND (${p.yearMax} IS NULL OR ${l.year} <= ${p.yearMax})
    AND (${p.priceMin} IS NULL OR ${l.price} >= ${p.priceMin})
    AND (${p.priceMax} IS NULL OR ${l.price} <= ${p.priceMax})
    AND (${p.kmMax} IS NULL OR ${l.km} <= ${p.kmMax})
    AND (cardinality(${p.fuels}) = 0 OR ${l.fuel} = ANY(${p.fuels}))
    AND (cardinality(${p.transmissions}) = 0 OR ${l.transmission} = ANY(${p.transmissions}))
    AND (cardinality(${p.cities}) = 0 OR fold_tr(${l.city}) IN (SELECT fold_tr(c) FROM unnest(${p.cities}) AS c))
    AND (${p.excludeDamaged} = false OR ${l.damaged} = false)
    AND (
          ${p.minDiscountPct} = 0
       OR ( (${l.confidence})::text <> 'INSUFFICIENT'
            AND ${l.discountPct} >= ${p.minDiscountPct}
            AND confidence_rank((${l.confidence})::text) >= confidence_rank((${p.minConfidence})::text) )
    )
  )`;
}

const col = (alias: string, name: string) => Prisma.raw(`${alias}."${name}"`);

const profileColumns = (a: string): ProfileSide => ({
  make: col(a, 'make'), model: col(a, 'model'), yearMin: col(a, 'yearMin'), yearMax: col(a, 'yearMax'),
  priceMin: col(a, 'priceMin'), priceMax: col(a, 'priceMax'), kmMax: col(a, 'kmMax'), fuels: col(a, 'fuels'),
  transmissions: col(a, 'transmissions'), cities: col(a, 'cities'), excludeDamaged: col(a, 'excludeDamaged'),
  minDiscountPct: col(a, 'minDiscountPct'), minConfidence: col(a, 'minConfidence'),
});

/** Parametreler açık tiplerle bağlanır; aksi halde `$1 IS NULL` "could not determine data type" hatası verir. */
const profileParams = (f: MatchFilter): ProfileSide => ({
  make: Prisma.sql`${f.make}::text`,
  model: Prisma.sql`${f.model}::text`,
  yearMin: Prisma.sql`${f.yearMin}::int`,
  yearMax: Prisma.sql`${f.yearMax}::int`,
  priceMin: Prisma.sql`${f.priceMin}::bigint`,
  priceMax: Prisma.sql`${f.priceMax}::bigint`,
  kmMax: Prisma.sql`${f.kmMax}::int`,
  fuels: Prisma.sql`${f.fuels}::"Fuel"[]`,
  transmissions: Prisma.sql`${f.transmissions}::"Transmission"[]`,
  cities: Prisma.sql`${f.cities}::text[]`,
  excludeDamaged: Prisma.sql`${f.excludeDamaged}::boolean`,
  minDiscountPct: Prisma.sql`${f.minDiscountPct}::numeric`,
  minConfidence: Prisma.sql`${f.minConfidence}::text`,
});

const listingColumns = (l: string, a: string): ListingSide => ({
  make: col(l, 'make'), model: col(l, 'model'), year: col(l, 'year'), km: col(l, 'km'), price: col(l, 'price'),
  fuel: col(l, 'fuel'), transmission: col(l, 'transmission'), city: col(l, 'city'),
  damaged: Prisma.raw(`('DAMAGED' = ANY(${a}."flags"))`), confidence: col(a, 'confidence'), discountPct: col(a, 'discountPct'),
});

const listingParams = (f: ListingFacts): ListingSide => ({
  make: Prisma.sql`${f.make}::text`,
  model: Prisma.sql`${f.model}::text`,
  year: Prisma.sql`${f.year}::int`,
  km: Prisma.sql`${f.km}::int`,
  price: Prisma.sql`${f.price}::bigint`,
  fuel: Prisma.sql`${f.fuel}::"Fuel"`,
  transmission: Prisma.sql`${f.transmission}::"Transmission"`,
  city: Prisma.sql`${f.city}::text`,
  damaged: Prisma.sql`${f.damaged}::boolean`,
  confidence: Prisma.sql`${f.confidence}::text`,
  discountPct: Prisma.sql`${f.discountPct}::numeric`,
});

export interface MatchingProfileRow {
  id: string;
  userId: string;
  notifyOnPriceDrop: boolean;
  priceDropPct: Prisma.Decimal;
  notifyOnRelist: boolean;
  /** Bu profile bu ilan için en son yazılan eşleşmenin fiyatı (yoksa null) */
  lastMatchedPrice: bigint | null;
}

export function findMatchingProfiles(db: RawDb, facts: ListingFacts, listingId: number): Promise<MatchingProfileRow[]> {
  return db.$queryRaw<MatchingProfileRow[]>(Prisma.sql`
    SELECT sp."id", sp."userId", sp."notifyOnPriceDrop", sp."priceDropPct", sp."notifyOnRelist",
      (SELECT m."matchedPrice" FROM "ListingMatch" m
        WHERE m."searchProfileId" = sp."id" AND m."listingId" = ${listingId}::int
        ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1) AS "lastMatchedPrice"
    FROM "SearchProfile" sp JOIN "User" u ON u."id" = sp."userId"
    WHERE sp."status" = 'ACTIVE' AND u."status" = 'ACTIVE'
      AND ${matchPredicate(profileColumns('sp'), listingParams(facts))}
    ORDER BY sp."id"`);
}

export interface PreviewListingRow {
  id: number;
  title: string;
  make: string;
  model: string;
  year: number;
  km: number;
  city: string | null;
  price: bigint;
  imageUrl: string | null;
  url: string;
  firstSeenAt: Date;
  opportunityScore: number;
  confidence: string;
  discountPct: Prisma.Decimal | null;
  estimatedPrice: bigint | null;
}

export function previewListings(db: RawDb, filter: MatchFilter, limit: number): Promise<PreviewListingRow[]> {
  return db.$queryRaw<PreviewListingRow[]>(Prisma.sql`
    SELECT l."id", l."title", l."make", l."model", l."year", l."km", l."city", l."price", l."imageUrl", l."url", l."firstSeenAt",
           a."opportunityScore", a."confidence"::text AS "confidence", a."discountPct", a."estimatedPrice"
    FROM "Listing" l JOIN "ListingAnalysis" a ON a."id" = l."latestAnalysisId"
    WHERE l."status" = 'ACTIVE' AND ${matchPredicate(profileParams(filter), listingColumns('l', 'a'))}
    ORDER BY l."firstSeenAt" DESC, l."id" DESC
    LIMIT ${limit}::int`);
}

export async function countPreviewSince(db: RawDb, filter: MatchFilter, since: Date): Promise<number> {
  const [row] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n
    FROM "Listing" l JOIN "ListingAnalysis" a ON a."id" = l."latestAnalysisId"
    WHERE l."status" = 'ACTIVE' AND l."firstSeenAt" >= ${since}
      AND ${matchPredicate(profileParams(filter), listingColumns('l', 'a'))}`);
  return Number(row?.n ?? 0);
}
```

`packages/db/src/index.ts` → `export * from './matching';` ekle.

- [ ] **Step 4: Testi ve derlemeyi çalıştır**

Run: `pnpm --filter @oto/db exec vitest run test/matching.spec.ts && pnpm --filter @oto/db test:e2e && pnpm --filter @oto/db build`
Expected: PASS (schema 7 + matching testleri). Enum dizisi parametre tipi hatası alırsan (`::"Fuel"[]`), Prisma'nın JS dizisini `text[]` olarak bağladığını doğrula; gerekirse `${f.fuels}::text[]::"Fuel"[]` kullan ve kararı rapora yaz.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): add single-source matching predicate with confidence_rank and fold_tr SQL functions"
```

---

### Task 3: Worker eşleştirme servisi

**Files:**
- Create: `apps/worker/src/matching/decide.ts`, `apps/worker/src/matching/decide.spec.ts`, `apps/worker/src/matching/match.service.ts`, `apps/worker/src/matching/matching.module.ts`, `apps/worker/test/match.e2e.spec.ts`
- Modify: `apps/worker/test/helpers.ts`

**Interfaces:**
- Consumes: `findMatchingProfiles`, `ListingFacts` (`@oto/db`), `MatchJobData`, `MatchEvent` (`@oto/shared`), `PrismaService`.
- Produces:
  - `decideMatchReason(event: MatchEvent, profile: { notifyOnPriceDrop: boolean; priceDropPct: number; notifyOnRelist: boolean }, lastMatchedPrice: bigint | null, price: bigint): MatchEvent | null`
  - `interface CreatedMatch { matchId: number; userId: string; searchProfileId: string; reason: MatchEvent }`
  - `type MatchOutcome = { status: 'MATCHED'; created: CreatedMatch[]; candidates: number } | { status: 'SKIPPED'; reason: 'NOT_FOUND' | 'LISTING_INACTIVE'; created: [] }`
  - `MatchService.process(data: MatchJobData): Promise<MatchOutcome>`
  - `MatchingModule` (exports `MatchService`)
  - test helpers: `createUser(ref, over?)`, `createProfile(ref, userId, over?)`, `createAnalysis(ref, listingId, over?)`

- [ ] **Step 1: Saf karar fonksiyonu için başarısız test**

`apps/worker/src/matching/decide.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideMatchReason } from './decide';

const P = { notifyOnPriceDrop: true, priceDropPct: 0.05, notifyOnRelist: true };

describe('decideMatchReason', () => {
  it('never-matched profile gets NEW for every event', () => {
    expect(decideMatchReason('NEW', P, null, 1000n)).toBe('NEW');
    expect(decideMatchReason('PRICE_DROP', { ...P, notifyOnPriceDrop: false }, null, 1000n)).toBe('NEW');
    expect(decideMatchReason('RELIST', { ...P, notifyOnRelist: false }, null, 1000n)).toBe('NEW');
  });
  it('already matched: repeated NEW at same or higher price yields nothing', () => {
    expect(decideMatchReason('NEW', P, 1000n, 1000n)).toBeNull();
    expect(decideMatchReason('NEW', P, 1000n, 1100n)).toBeNull();
  });
  it('price drop threshold is inclusive and relative to the last matched price', () => {
    expect(decideMatchReason('PRICE_DROP', P, 1_000_000n, 950_000n)).toBe('PRICE_DROP');
    expect(decideMatchReason('PRICE_DROP', P, 1_000_000n, 950_001n)).toBeNull();
    expect(decideMatchReason('PRICE_DROP', { ...P, notifyOnPriceDrop: false }, 1_000_000n, 500_000n)).toBeNull();
    // Yükseltme kaynaklı NEW olayı da yeterli düşüşte PRICE_DROP üretir
    expect(decideMatchReason('NEW', P, 1_000_000n, 900_000n)).toBe('PRICE_DROP');
  });
  it('relist goes to RELIST profiles; a cheaper relist also feeds price-drop profiles', () => {
    expect(decideMatchReason('RELIST', P, 1_000_000n, 1_000_000n)).toBe('RELIST');
    expect(decideMatchReason('RELIST', { ...P, notifyOnRelist: false }, 1_000_000n, 1_000_000n)).toBeNull();
    expect(decideMatchReason('RELIST', { ...P, notifyOnRelist: false }, 1_000_000n, 900_000n)).toBe('PRICE_DROP');
  });
});
```

Run: `pnpm --filter @oto/worker exec vitest run src/matching/decide.spec.ts` → FAIL (modül yok).

- [ ] **Step 2: Karar fonksiyonunu yaz**

`apps/worker/src/matching/decide.ts`:

```ts
import type { MatchEvent } from '@oto/shared';

export interface ProfileNotifyPrefs {
  notifyOnPriceDrop: boolean;
  /** Kesir: 0.05 = %5 */
  priceDropPct: number;
  notifyOnRelist: boolean;
}

/**
 * Profil başına eşleşme nedeni (spec §5.1):
 * - Profile bu ilan için hiç eşleşme yazılmamışsa olay ne olursa olsun NEW.
 * - RELIST olayı + notifyOnRelist → RELIST.
 * - notifyOnPriceDrop ve fiyat son eşleşme fiyatından en az priceDropPct düşük → PRICE_DROP.
 * - Aksi halde eşleşme yok.
 */
export function decideMatchReason(
  event: MatchEvent,
  profile: ProfileNotifyPrefs,
  lastMatchedPrice: bigint | null,
  price: bigint,
): MatchEvent | null {
  if (lastMatchedPrice === null) return 'NEW';
  if (event === 'RELIST' && profile.notifyOnRelist) return 'RELIST';
  if (profile.notifyOnPriceDrop) {
    const keepBp = BigInt(Math.round((1 - profile.priceDropPct) * 10_000));
    if (price * 10_000n <= lastMatchedPrice * keepBp) return 'PRICE_DROP';
  }
  return null;
}
```

Run aynı komut → PASS.

- [ ] **Step 3: Servis için başarısız e2e testi**

`apps/worker/test/helpers.ts` sonuna:

```ts
let userSeq = 0;
export async function createUser(ref: TestingModule, over: Record<string, unknown> = {}) {
  userSeq += 1;
  return ref.get(PrismaService).user.create({ data: { email: `w${userSeq}@test.com`, passwordHash: 'x', name: `U${userSeq}`, ...over } });
}

export async function createProfile(ref: TestingModule, userId: string, over: Record<string, unknown> = {}) {
  return ref.get(PrismaService).searchProfile.create({ data: { userId, name: 'Profil', channels: ['IN_APP'], minDiscountPct: 0, ...over } });
}

/** Analiz satırı yazar ve ilanın latestAnalysisId'sini günceller. */
export async function createAnalysis(ref: TestingModule, listingId: number, over: Record<string, unknown> = {}) {
  const prisma = ref.get(PrismaService);
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
  const a = await prisma.listingAnalysis.create({
    data: {
      listingId, engineVersion: 'rules-v1', estimatedPrice: 1_200_000n, priceDiff: 240_000n, discountPct: 0.2, opportunityScore: 77,
      comparableCount: 14, confidence: 'HIGH', flags: [], explanation: {}, comparableIds: [], listingPrice: listing.price,
      listingContentHash: listing.contentHash, ...over,
    },
  });
  await prisma.listing.update({ where: { id: listingId }, data: { latestAnalysisId: a.id } });
  return a;
}
```

`apps/worker/test/match.e2e.spec.ts`:

```ts
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { createAnalysis, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let svc: MatchService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([MatchingModule]);
  prisma = ref.get(PrismaService);
  svc = ref.get(MatchService);
});
afterAll(async () => ref.close());
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function setup(price = 960_000n) {
  const l = await createListing(ref, sourceId, { price, city: 'İstanbul' });
  const a = await createAnalysis(ref, l.id);
  return { l, a };
}

describe('MatchService', () => {
  it('creates NEW matches for matching active profiles only', async () => {
    const { l, a } = await setup();
    const u1 = await createUser(ref);
    const u2 = await createUser(ref);
    const hit = await createProfile(ref, u1.id, { make: 'bmw', minDiscountPct: 0.1 });
    await createProfile(ref, u2.id, { make: 'Audi' });
    await createProfile(ref, u2.id, { status: 'PAUSED' });
    const out = await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect(out.status).toBe('MATCHED');
    expect(out.created).toEqual([expect.objectContaining({ searchProfileId: hit.id, userId: u1.id, reason: 'NEW' })]);
    const rows = await prisma.listingMatch.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ analysisId: a.id, matchedPrice: 960_000n, reason: 'NEW' });
  });

  it('is idempotent for duplicate and concurrent jobs', async () => {
    const { l, a } = await setup();
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const job = { listingId: l.id, analysisId: a.id, event: 'NEW' as const };
    await Promise.all([svc.process(job), svc.process(job), svc.process(job)]);
    await svc.process(job);
    expect(await prisma.listingMatch.count()).toBe(1);
  });

  it('price drop: notifies at threshold relative to the last matched price', async () => {
    const { l, a } = await setup(1_000_000n);
    const u = await createUser(ref);
    await createProfile(ref, u.id, { priceDropPct: 0.05 });
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    await prisma.listing.update({ where: { id: l.id }, data: { price: 960_000n } });
    const small = await createAnalysis(ref, l.id, { listingPrice: 960_000n });
    expect((await svc.process({ listingId: l.id, analysisId: small.id, event: 'PRICE_DROP', previousPrice: '1000000' })).created).toEqual([]);
    const big = await createAnalysis(ref, l.id, { listingPrice: 940_000n });
    const out = await svc.process({ listingId: l.id, analysisId: big.id, event: 'PRICE_DROP', previousPrice: '960000' });
    expect(out.created.map((c) => c.reason)).toEqual(['PRICE_DROP']);
  });

  it('out-of-order: PRICE_DROP before NEW yields a single NEW', async () => {
    const { l, a: first } = await setup(1_000_000n);
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const second = await createAnalysis(ref, l.id, { listingPrice: 900_000n });
    await svc.process({ listingId: l.id, analysisId: second.id, event: 'PRICE_DROP', previousPrice: '1000000' });
    await svc.process({ listingId: l.id, analysisId: first.id, event: 'NEW' });
    const rows = await prisma.listingMatch.findMany();
    expect(rows.map((r) => [r.reason, r.matchedPrice])).toEqual([['NEW', 900_000n]]);
  });

  it('relist reaches RELIST profiles; never-matched profiles get NEW', async () => {
    const { l, a } = await setup();
    const u = await createUser(ref);
    const relister = await createProfile(ref, u.id, { notifyOnRelist: true, notifyOnPriceDrop: false });
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    const late = await createProfile(ref, u.id, { notifyOnRelist: false });
    const ra = await createAnalysis(ref, l.id);
    const out = await svc.process({ listingId: l.id, analysisId: ra.id, event: 'RELIST' });
    expect(out.created.map((c) => [c.searchProfileId, c.reason]).sort()).toEqual([[late.id, 'NEW'], [relister.id, 'RELIST']].sort());
  });

  it('uses analysis flags for damage and skips removed listings / unknown analyses', async () => {
    const { l, a } = await setup();
    await prisma.listingAnalysis.update({ where: { id: a.id }, data: { flags: ['DAMAGED'] } });
    const u = await createUser(ref);
    await createProfile(ref, u.id, { excludeDamaged: true });
    expect((await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).created).toEqual([]);
    await prisma.listing.update({ where: { id: l.id }, data: { status: 'REMOVED' } });
    expect(await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).toMatchObject({ status: 'SKIPPED', reason: 'LISTING_INACTIVE' });
    expect(await svc.process({ listingId: l.id, analysisId: 999_999, event: 'NEW' })).toMatchObject({ status: 'SKIPPED', reason: 'NOT_FOUND' });
  });

  it('suspended users are not matched', async () => {
    const { l, a } = await setup();
    const u = await createUser(ref, { status: 'SUSPENDED' });
    await createProfile(ref, u.id);
    expect((await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).created).toEqual([]);
  });
});
```

Run: `pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts test/match.e2e.spec.ts` → FAIL (modül yok).

- [ ] **Step 4: Servisi ve modülü yaz**

`apps/worker/src/matching/match.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { findMatchingProfiles, type ListingFacts } from '@oto/db';
import type { MatchEvent, MatchJobData } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { decideMatchReason } from './decide';

/** pg_advisory_xact_lock(ad alanı, ilan id): aynı ilanın eşleştirmesi tek seferde bir işte çalışır. */
const MATCH_LOCK_NAMESPACE = 4242;

export interface CreatedMatch {
  matchId: number;
  userId: string;
  searchProfileId: string;
  reason: MatchEvent;
}

export type MatchOutcome =
  | { status: 'MATCHED'; created: CreatedMatch[]; candidates: number }
  | { status: 'SKIPPED'; reason: 'NOT_FOUND' | 'LISTING_INACTIVE'; created: [] };

@Injectable()
export class MatchService {
  private readonly logger = new Logger(MatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(data: MatchJobData): Promise<MatchOutcome> {
    const out = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MATCH_LOCK_NAMESPACE}::int, ${data.listingId}::int)`;
        const analysis = await tx.listingAnalysis.findUnique({ where: { id: data.analysisId }, include: { listing: true } });
        if (!analysis || analysis.listingId !== data.listingId) return { status: 'SKIPPED', reason: 'NOT_FOUND', created: [] } as const;
        const listing = analysis.listing;
        if (listing.status !== 'ACTIVE') return { status: 'SKIPPED', reason: 'LISTING_INACTIVE', created: [] } as const;

        const price = analysis.listingPrice ?? listing.price;
        const facts: ListingFacts = {
          make: listing.make,
          model: listing.model,
          year: listing.year,
          km: listing.km,
          price,
          fuel: listing.fuel,
          transmission: listing.transmission,
          city: listing.city,
          damaged: analysis.flags.includes('DAMAGED'),
          confidence: analysis.confidence,
          discountPct: analysis.discountPct === null ? null : Number(analysis.discountPct),
        };
        const candidates = await findMatchingProfiles(tx, facts, listing.id);
        const created: CreatedMatch[] = [];
        for (const c of candidates) {
          const reason = decideMatchReason(
            data.event,
            { notifyOnPriceDrop: c.notifyOnPriceDrop, priceDropPct: Number(c.priceDropPct), notifyOnRelist: c.notifyOnRelist },
            c.lastMatchedPrice,
            price,
          );
          if (!reason) continue;
          const rows = await tx.$queryRaw<{ id: number }[]>`
            INSERT INTO "ListingMatch" ("userId", "searchProfileId", "listingId", "analysisId", "reason", "matchedPrice")
            VALUES (${c.userId}, ${c.id}, ${listing.id}::int, ${analysis.id}::int, ${reason}::"MatchReason", ${price}::bigint)
            ON CONFLICT ("searchProfileId", "listingId", "reason", "matchedPrice") DO NOTHING
            RETURNING "id"`;
          if (rows[0]) created.push({ matchId: rows[0].id, userId: c.userId, searchProfileId: c.id, reason });
        }
        return { status: 'MATCHED', created, candidates: candidates.length } as const;
      },
      { timeout: 30_000 },
    );
    if (out.status === 'MATCHED' && out.created.length > 0) {
      this.logger.log(`İlan ${data.listingId} (${data.event}): ${out.created.length} eşleşme`);
    }
    return out as MatchOutcome;
  }
}
```

`apps/worker/src/matching/matching.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MatchService } from './match.service';

@Module({ providers: [MatchService], exports: [MatchService] })
export class MatchingModule {}
```

(`PrismaService`'in worker'da global `CoreModule`/`InfraModule` üzerinden enjekte edildiğini `analysis.module.ts` ile aynı biçimde doğrula; `AnalysisModule` ek import yapmıyorsa burada da gerekmez.)

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm --filter @oto/worker exec vitest run src/matching/decide.spec.ts && pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts test/match.e2e.spec.ts`
Expected: PASS. (`@oto/db` değiştiyse önce `pnpm --filter @oto/db build`.)

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/matching apps/worker/test/match.e2e.spec.ts apps/worker/test/helpers.ts
git commit -m "feat(worker): add match service with per-listing advisory lock and per-profile reason decision"
```

---

### Task 4: `match` kuyruğu tüketicisi

**Files:**
- Create: `apps/worker/src/processors/match-worker.host.ts`, `apps/worker/test/match-worker.e2e.spec.ts`
- Modify: `apps/worker/src/config/env.ts`, `apps/worker/src/config/env.spec.ts`, `apps/worker/src/worker-app.module.ts`

**Interfaces:**
- Consumes: `MatchService.process`, `matchJobSchema`, `QueueName.MATCH`, `bullConnection`, `RETRYING_JOB_OPTS`, `QueueRegistry.match`.
- Produces: `MATCH_WORKER_AUTOSTART` token, `MatchWorkerHost` (`start()`, `onModuleDestroy()`); env `MATCH_CONCURRENCY` (varsayılan 4, 1–32).

- [ ] **Step 1: Başarısız testleri yaz**

`apps/worker/src/config/env.spec.ts` → defaults testine `expect(parseEnv(base).MATCH_CONCURRENCY).toBe(4);` ekle ve:

```ts
  it('bounds MATCH_CONCURRENCY', () => {
    expect(() => parseEnv({ ...base, MATCH_CONCURRENCY: '0' })).toThrow(/MATCH_CONCURRENCY/);
    expect(() => parseEnv({ ...base, MATCH_CONCURRENCY: '33' })).toThrow(/MATCH_CONCURRENCY/);
    expect(parseEnv({ ...base, MATCH_CONCURRENCY: '8' }).MATCH_CONCURRENCY).toBe(8);
  });
```

`apps/worker/test/match-worker.e2e.spec.ts`:

```ts
import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MATCH_WORKER_AUTOSTART, MatchWorkerHost } from '../src/processors/match-worker.host';
import { RETRYING_JOB_OPTS } from '../src/queues/job-options';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAnalysis, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

@Module({
  imports: [MatchingModule],
  providers: [MatchWorkerHost, { provide: MATCH_WORKER_AUTOSTART, useValue: false }],
  exports: [MatchWorkerHost],
})
class MatchTestModule {}

let ref: TestingModule;

beforeAll(async () => {
  ref = await createContext([MatchTestModule]);
  ref.get(MatchWorkerHost).start();
});
afterAll(async () => {
  await ref.get(MatchWorkerHost).onModuleDestroy();
  await ref.close();
});
beforeEach(async () => resetState(ref));

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timed out');
}

describe('MatchWorkerHost', () => {
  it('consumes match jobs into ListingMatch rows', async () => {
    const sourceId = (await createSource(ref, 'http://demo.invalid')).id;
    const l = await createListing(ref, sourceId);
    const a = await createAnalysis(ref, l.id);
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    await ref.get(QueueRegistry).match.add('match', { listingId: l.id, analysisId: a.id, event: 'NEW' }, { jobId: `match-${a.id}`, ...RETRYING_JOB_OPTS });
    const m = await waitFor(() => ref.get(PrismaService).listingMatch.findFirst({ where: { listingId: l.id } }));
    expect(m.reason).toBe('NEW');
  });

  it('fails malformed payloads on the first attempt and keeps consuming', async () => {
    const queue = ref.get(QueueRegistry).match;
    const bad = await queue.add('match', { listingId: 1, analysisId: 0, event: 'NEW' } as never, { jobId: 'bad-match-1', ...RETRYING_JOB_OPTS });
    await waitFor(async () => ((await bad.getState()) === 'failed' ? true : null));
    const failed = await queue.getJob('bad-match-1');
    expect(failed?.failedReason).toContain('Geçersiz eşleştirme işi');
    expect(failed?.attemptsMade).toBe(1);
  });
});
```

Run: `pnpm --filter @oto/worker test && pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts test/match-worker.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`apps/worker/src/config/env.ts` → `ANALYZE_CONCURRENCY` satırının altına: `MATCH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),`

`apps/worker/src/processors/match-worker.host.ts`:

```ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { matchJobSchema, QueueName, type MatchJobData } from '@oto/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';
import { MatchService } from '../matching/match.service';

export const MATCH_WORKER_AUTOSTART = Symbol('MATCH_WORKER_AUTOSTART');

@Injectable()
export class MatchWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchWorkerHost.name);
  private worker?: Worker<MatchJobData>;

  constructor(
    private readonly matching: MatchService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(MATCH_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<MatchJobData>(
      QueueName.MATCH,
      async (job) => {
        const parsed = matchJobSchema.safeParse(job.data);
        // Bozuk payload kalıcı hatadır; yeniden denemek anlamsız.
        if (!parsed.success) throw new UnrecoverableError(`Geçersiz eşleştirme işi: ${parsed.error.message}`);
        await this.matching.process(parsed.data);
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: this.env.MATCH_CONCURRENCY },
    );
    this.worker.on('error', (err) => this.logger.error(`Eşleştirme worker hatası: ${err.message}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`Eşleştirme işi ${job?.id} başarısız (deneme ${job?.attemptsMade}): ${err.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
```

`apps/worker/src/worker-app.module.ts` → `imports`'a `MatchingModule`, `providers`'a `MatchWorkerHost` ekle.

- [ ] **Step 3: Testleri, lint, typecheck, build**

Run: `pnpm --filter @oto/worker test && pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts && pnpm lint && pnpm typecheck && pnpm --filter @oto/worker build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): consume match queue with configurable concurrency"
```

---

### Task 5: Arama profilleri API'si (CRUD, duraklat/sürdür, limitler)

**Files:**
- Create: `apps/api/src/modules/me/limits.service.ts`, `apps/api/src/modules/me/search-profiles.repository.ts`, `apps/api/src/modules/me/search-profiles.service.ts`, `apps/api/src/modules/me/search-profiles.controller.ts`, `apps/api/src/modules/me/search-profile.view.ts`, `apps/api/test/search-profiles.e2e.spec.ts`
- Modify: `apps/api/src/modules/me/me.module.ts`, `apps/api/src/modules/me/me.repository.ts` (`findPlanByCode`), `apps/api/src/modules/me/me.service.ts` (etkin limitler), `apps/api/test/isolation.e2e.spec.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: Task 1 şemaları, `effectiveLimits`, `planLimitsSchema`, `ErrorCode.LIMIT_REACHED`, `MeRepository.findUser/findActiveSubscription`.
- Produces:
  - `LimitsService.forUser(userId): Promise<{ planCode: string; limits: PlanLimits; emailVerified: boolean; maxSearchProfiles: number }>` — `maxSearchProfiles` doğrulanmamışsa `min(1, limits.maxSearchProfiles)`.
  - `SearchProfileView` ve `toSearchProfileView(p: SearchProfile): SearchProfileView` (para string, oranlar number).
  - Route'lar: `GET/POST /me/search-profiles`, `GET/PATCH/DELETE /me/search-profiles/:id`, `POST /me/search-profiles/:id/pause`, `POST /me/search-profiles/:id/resume`.
  - Test helper: `verifyEmail(app, userId)`.

- [ ] **Step 1: Başarısız e2e testleri yaz**

`apps/api/test/helpers.ts` sonuna:

```ts
export async function verifyEmail(app: NestExpressApplication, userId: string): Promise<void> {
  await app.get(PrismaService).user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
}
```

`apps/api/test/search-profiles.e2e.spec.ts`:

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, verifyEmail } from './helpers';

let app: NestExpressApplication;
const URL = '/api/v1/me/search-profiles';

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('/me/search-profiles', () => {
  it('creates with defaults and returns money as strings', async () => {
    const A = await registerUser(app);
    const res = await A.agent.post(URL).send({ name: 'BMW', make: 'BMW', priceMax: '1500000', minDiscountPct: 0.1, channels: ['TELEGRAM'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'BMW', make: 'BMW', priceMax: '1500000', priceMin: null, minDiscountPct: 0.1, priceDropPct: 0.05,
      minConfidence: 'MEDIUM', status: 'ACTIVE', channels: ['IN_APP', 'TELEGRAM'],
    });
    const list = await A.agent.get(URL);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([res.body.id]);
  });

  it('rejects invalid input with VALIDATION_FAILED', async () => {
    const A = await registerUser(app);
    const res = await A.agent.post(URL).send({ name: 'x', yearMin: 2022, yearMax: 2020 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await A.agent.post(URL).send({ name: 'x', channels: ['EMAIL'] })).status).toBe(400);
  });

  it('unverified accounts get at most one profile', async () => {
    const A = await registerUser(app);
    expect((await A.agent.post(URL).send({ name: '1' })).status).toBe(201);
    const second = await A.agent.post(URL).send({ name: '2' });
    expect(second.status).toBe(403);
    expect(second.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { limit: 1, reason: 'EMAIL_NOT_VERIFIED' } });
  });

  it('enforces plan limit under concurrent creates', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    const results = await Promise.all([1, 2, 3, 4].map((i) => A.agent.post(URL).send({ name: `p${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 403, 403]);
    expect(await app.get(PrismaService).searchProfile.count({ where: { userId: A.user.id } })).toBe(2);
  });

  it('applies limitOverrides', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    await app.get(PrismaService).userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { maxSearchProfiles: 3 } } });
    for (const i of [1, 2, 3]) expect((await A.agent.post(URL).send({ name: `p${i}` })).status).toBe(201);
    expect((await A.agent.post(URL).send({ name: 'p4' })).status).toBe(403);
    expect((await A.agent.get('/api/v1/me')).body.subscription.limits.maxSearchProfiles).toBe(3);
  });

  it('rejects channels the plan does not include', async () => {
    const A = await registerUser(app);
    const prisma = app.get(PrismaService);
    await prisma.userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { channels: ['IN_APP'] } } });
    const res = await A.agent.post(URL).send({ name: 'x', channels: ['TELEGRAM'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { channel: 'TELEGRAM' } });
  });

  it('patch merges, re-validates cross fields and keeps IN_APP', async () => {
    const A = await registerUser(app);
    const { id } = (await A.agent.post(URL).send({ name: 'x', yearMin: 2018 })).body;
    expect((await A.agent.patch(`${URL}/${id}`).send({ yearMax: 2017 })).status).toBe(400);
    const ok = await A.agent.patch(`${URL}/${id}`).send({ yearMax: 2020, channels: [] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ yearMin: 2018, yearMax: 2020, channels: ['IN_APP'] });
    expect((await A.agent.patch(`${URL}/${id}`).send({ make: null, model: 'X' })).status).toBe(400);
  });

  it('pause/resume and resume respects the active limit', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    const p1 = (await A.agent.post(URL).send({ name: '1' })).body.id;
    const p2 = (await A.agent.post(URL).send({ name: '2' })).body.id;
    expect((await A.agent.post(`${URL}/${p1}/pause`)).body.status).toBe('PAUSED');
    expect((await A.agent.post(`${URL}/${p1}/resume`)).body.status).toBe('ACTIVE');
    // Plan düşürüldü: limit 1, iki profil var
    await app.get(PrismaService).userSubscription.updateMany({ where: { userId: A.user.id }, data: { limitOverrides: { maxSearchProfiles: 1 } } });
    await A.agent.post(`${URL}/${p2}/pause`);
    expect((await A.agent.post(`${URL}/${p2}/resume`)).status).toBe(403);
  });

  it('get/delete own profile; unknown id is 404', async () => {
    const A = await registerUser(app);
    const { id } = (await A.agent.post(URL).send({ name: 'x' })).body;
    expect((await A.agent.get(`${URL}/${id}`)).status).toBe(200);
    expect((await A.agent.delete(`${URL}/${id}`)).status).toBe(204);
    expect((await A.agent.get(`${URL}/${id}`)).status).toBe(404);
    expect((await A.agent.delete(`${URL}/${id}`)).status).toBe(404);
  });
});
```

`apps/api/test/isolation.e2e.spec.ts` `CASES` içine ekle (şimdilik yalnızca bu task'ın route'ları; preview ve matches Task 6'da):

```ts
  'GET /me/search-profiles': async ({ A, B }) => {
    await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A profili' });
    const res = await B.agent.get('/api/v1/me/search-profiles');
    expect(res.body.items).toEqual([]);
  },
  'POST /me/search-profiles': async ({ A, B }) => {
    await B.agent.post('/api/v1/me/search-profiles').send({ name: 'B profili' });
    expect((await A.agent.get('/api/v1/me/search-profiles')).body.items).toEqual([]);
  },
  'GET /me/search-profiles/:id': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.get(`/api/v1/me/search-profiles/${id}`)).status).toBe(404);
  },
  'PATCH /me/search-profiles/:id': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.patch(`/api/v1/me/search-profiles/${id}`).send({ name: 'B' })).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).body.name).toBe('A');
  },
  'DELETE /me/search-profiles/:id': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.delete(`/api/v1/me/search-profiles/${id}`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).status).toBe(200);
  },
  'POST /me/search-profiles/:id/pause': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    expect((await B.agent.post(`/api/v1/me/search-profiles/${id}/pause`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).body.status).toBe('ACTIVE');
  },
  'POST /me/search-profiles/:id/resume': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    await A.agent.post(`/api/v1/me/search-profiles/${id}/pause`);
    expect((await B.agent.post(`/api/v1/me/search-profiles/${id}/resume`)).status).toBe(404);
    expect((await A.agent.get(`/api/v1/me/search-profiles/${id}`)).body.status).toBe('PAUSED');
  },
```

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/search-profiles.e2e.spec.ts test/isolation.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`apps/api/src/modules/me/me.repository.ts` → ekle:

```ts
  findPlanByCode(code: string): Promise<SubscriptionPlan | null> {
    return this.prisma.subscriptionPlan.findUnique({ where: { code } });
  }
```

`apps/api/src/modules/me/limits.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { effectiveLimits, planLimitsSchema, type PlanLimits } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { MeRepository } from './me.repository';

export interface UserLimits {
  planCode: string;
  limits: PlanLimits;
  emailVerified: boolean;
  /** Doğrulanmamış hesapta en fazla 1 (spec §6) */
  maxSearchProfiles: number;
}

@Injectable()
export class LimitsService {
  constructor(private readonly repo: MeRepository) {}

  /** Aktif ve süresi dolmamış abonelik yoksa FREE planı geçerlidir. */
  async forUser(userId: string, now = new Date()): Promise<UserLimits> {
    const user = await this.repo.findUser(userId);
    if (!user) throw Errors.unauthenticated();
    const sub = await this.repo.findActiveSubscription(userId);
    const live = sub && (!sub.endsAt || sub.endsAt > now) ? sub : null;
    const plan = live?.plan ?? (await this.repo.findPlanByCode('FREE'));
    if (!plan) throw new Error('FREE planı tanımlı değil (seedPlans çalıştırılmalı)');
    const limits = effectiveLimits(planLimitsSchema.parse(plan.limits), live?.limitOverrides ?? null);
    const emailVerified = user.emailVerifiedAt !== null;
    return {
      planCode: plan.code,
      limits,
      emailVerified,
      maxSearchProfiles: emailVerified ? limits.maxSearchProfiles : Math.min(1, limits.maxSearchProfiles),
    };
  }
}
```

`apps/api/src/modules/me/me.service.ts` → `getProfile` içinde `limits: planLimitsSchema.parse(sub.plan.limits)` yerine `LimitsService` enjekte edip `limits: (await this.limits.forUser(userId)).limits` kullan (abonelik nesnesi yine `sub` üzerinden döner; `sub` yoksa `subscription: null` davranışı korunur).

`apps/api/src/modules/me/search-profile.view.ts`:

```ts
import type { SearchProfile } from '@oto/db';

export interface SearchProfileView {
  id: string;
  name: string;
  status: string;
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  priceMin: string | null;
  priceMax: string | null;
  kmMax: number | null;
  fuels: string[];
  transmissions: string[];
  cities: string[];
  minDiscountPct: number;
  minConfidence: string;
  excludeDamaged: boolean;
  notifyOnPriceDrop: boolean;
  priceDropPct: number;
  notifyOnRelist: boolean;
  channels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function toSearchProfileView(p: SearchProfile): SearchProfileView {
  return {
    id: p.id, name: p.name, status: p.status, make: p.make, model: p.model, yearMin: p.yearMin, yearMax: p.yearMax,
    priceMin: p.priceMin?.toString() ?? null, priceMax: p.priceMax?.toString() ?? null, kmMax: p.kmMax,
    fuels: p.fuels, transmissions: p.transmissions, cities: p.cities, minDiscountPct: Number(p.minDiscountPct),
    minConfidence: p.minConfidence, excludeDamaged: p.excludeDamaged, notifyOnPriceDrop: p.notifyOnPriceDrop,
    priceDropPct: Number(p.priceDropPct), notifyOnRelist: p.notifyOnRelist, channels: p.channels,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}
```

`apps/api/src/modules/me/search-profiles.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { NormalizedProfile } from '@oto/shared';
import type { SearchProfile } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

function toData(p: NormalizedProfile) {
  return {
    ...p,
    priceMin: p.priceMin === null ? null : BigInt(p.priceMin),
    priceMax: p.priceMax === null ? null : BigInt(p.priceMax),
    fuels: p.fuels as SearchProfile['fuels'],
    transmissions: p.transmissions as SearchProfile['transmissions'],
    channels: p.channels as SearchProfile['channels'],
  };
}

/** Arama profillerine TEK erişim noktası; her sorgu userId ile kapsamlıdır. */
@Injectable()
export class SearchProfilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string): Promise<SearchProfile[]> {
    return this.prisma.searchProfile.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  find(userId: string, id: string): Promise<SearchProfile | null> {
    return this.prisma.searchProfile.findFirst({ where: { id, userId } });
  }

  /** Kullanıcı başına advisory kilit altında sayar ve oluşturur; limit doluysa null. */
  createWithinLimit(userId: string, p: NormalizedProfile, max: number): Promise<SearchProfile | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`profiles:${userId}`}))`;
      if ((await tx.searchProfile.count({ where: { userId } })) >= max) return null;
      return tx.searchProfile.create({ data: { ...toData(p), userId } });
    });
  }

  async update(userId: string, id: string, p: NormalizedProfile): Promise<SearchProfile | null> {
    const res = await this.prisma.searchProfile.updateMany({ where: { id, userId }, data: toData(p) });
    return res.count === 1 ? this.find(userId, id) : null;
  }

  async setStatus(userId: string, id: string, status: 'ACTIVE' | 'PAUSED'): Promise<SearchProfile | null> {
    const res = await this.prisma.searchProfile.updateMany({ where: { id, userId }, data: { status } });
    return res.count === 1 ? this.find(userId, id) : null;
  }

  /** Sürdürme: ACTIVE profil sayısı (bu profil hariç) < max ise ACTIVE yapar; kilit altında. */
  resumeWithinLimit(userId: string, id: string, max: number): Promise<SearchProfile | null | 'LIMIT'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`profiles:${userId}`}))`;
      const own = await tx.searchProfile.findFirst({ where: { id, userId } });
      if (!own) return null;
      if (own.status === 'ACTIVE') return own;
      if ((await tx.searchProfile.count({ where: { userId, status: 'ACTIVE' } })) >= max) return 'LIMIT' as const;
      return tx.searchProfile.update({ where: { id: own.id }, data: { status: 'ACTIVE' } });
    });
  }

  async delete(userId: string, id: string): Promise<boolean> {
    return (await this.prisma.searchProfile.deleteMany({ where: { id, userId } })).count === 1;
  }
}
```

Not (advisory kilit): `tx.$executeRaw\`SELECT pg_advisory_xact_lock(...)\`` Postgres'te çalışır; Prisma `void` dönüş tipiyle sorun çıkarırsa `tx.$queryRaw\`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(...)) AS l\`` kullan (Task 3'teki `MatchService` için de aynı).

`apps/api/src/modules/me/search-profiles.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  createSearchProfileSchema,
  ErrorCode,
  withProfileDefaults,
  type CreateSearchProfileInput,
  type NormalizedProfile,
  type UpdateSearchProfileInput,
} from '@oto/shared';
import type { SearchProfile } from '@oto/db';
import { AppError, Errors } from '../../common/errors/app-error';
import { LimitsService, type UserLimits } from './limits.service';
import { toSearchProfileView, type SearchProfileView } from './search-profile.view';
import { SearchProfilesRepository } from './search-profiles.repository';

function toInput(p: SearchProfile): CreateSearchProfileInput {
  return {
    name: p.name, make: p.make, model: p.model, yearMin: p.yearMin, yearMax: p.yearMax,
    priceMin: p.priceMin?.toString() ?? null, priceMax: p.priceMax?.toString() ?? null, kmMax: p.kmMax,
    fuels: p.fuels, transmissions: p.transmissions, cities: p.cities, minDiscountPct: Number(p.minDiscountPct),
    minConfidence: p.minConfidence === 'INSUFFICIENT' ? 'LOW' : p.minConfidence, excludeDamaged: p.excludeDamaged,
    notifyOnPriceDrop: p.notifyOnPriceDrop, priceDropPct: Number(p.priceDropPct), notifyOnRelist: p.notifyOnRelist,
    channels: p.channels.filter((c): c is 'IN_APP' | 'TELEGRAM' => c !== 'EMAIL'),
  };
}

@Injectable()
export class SearchProfilesService {
  constructor(
    private readonly repo: SearchProfilesRepository,
    private readonly limits: LimitsService,
  ) {}

  async list(userId: string): Promise<{ items: SearchProfileView[] }> {
    return { items: (await this.repo.list(userId)).map(toSearchProfileView) };
  }

  async get(userId: string, id: string): Promise<SearchProfileView> {
    const p = await this.repo.find(userId, id);
    if (!p) throw Errors.notFound();
    return toSearchProfileView(p);
  }

  async create(userId: string, input: CreateSearchProfileInput): Promise<SearchProfileView> {
    const lim = await this.limits.forUser(userId);
    const p = withProfileDefaults(input);
    this.assertChannels(p, lim);
    const created = await this.repo.createWithinLimit(userId, p, lim.maxSearchProfiles);
    if (!created) throw this.limitError(lim);
    return toSearchProfileView(created);
  }

  async update(userId: string, id: string, patch: UpdateSearchProfileInput): Promise<SearchProfileView> {
    const existing = await this.repo.find(userId, id);
    if (!existing) throw Errors.notFound();
    const merged = createSearchProfileSchema.safeParse({ ...toInput(existing), ...patch });
    if (!merged.success) {
      throw Errors.validation(merged.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const p = withProfileDefaults(merged.data);
    this.assertChannels(p, await this.limits.forUser(userId));
    const updated = await this.repo.update(userId, id, p);
    if (!updated) throw Errors.notFound();
    return toSearchProfileView(updated);
  }

  async pause(userId: string, id: string): Promise<SearchProfileView> {
    const p = await this.repo.setStatus(userId, id, 'PAUSED');
    if (!p) throw Errors.notFound();
    return toSearchProfileView(p);
  }

  async resume(userId: string, id: string): Promise<SearchProfileView> {
    const lim = await this.limits.forUser(userId);
    const r = await this.repo.resumeWithinLimit(userId, id, lim.maxSearchProfiles);
    if (r === null) throw Errors.notFound();
    if (r === 'LIMIT') throw this.limitError(lim);
    return toSearchProfileView(r);
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.repo.delete(userId, id))) throw Errors.notFound();
  }

  private assertChannels(p: NormalizedProfile, lim: UserLimits): void {
    const missing = p.channels.find((c) => !lim.limits.channels.includes(c));
    if (missing) throw new AppError(ErrorCode.LIMIT_REACHED, 403, 'Planınız bu bildirim kanalını içermiyor', { channel: missing });
  }

  private limitError(lim: UserLimits): AppError {
    return new AppError(
      ErrorCode.LIMIT_REACHED,
      403,
      lim.emailVerified ? 'Planınızın arama profili sınırına ulaştınız' : 'E-postanızı doğrulayana kadar yalnızca 1 arama profili oluşturabilirsiniz',
      { limit: lim.maxSearchProfiles, reason: lim.emailVerified ? 'PLAN' : 'EMAIL_NOT_VERIFIED' },
    );
  }
}
```

`apps/api/src/modules/me/search-profiles.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createSearchProfileSchema,
  updateSearchProfileSchema,
  type CreateSearchProfileInput,
  type UpdateSearchProfileInput,
} from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { SearchProfilesService } from './search-profiles.service';

@Controller('me/search-profiles')
export class SearchProfilesController {
  constructor(private readonly profiles: SearchProfilesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.profiles.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(createSearchProfileSchema)) body: CreateSearchProfileInput) {
    return this.profiles.create(user.id, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.get(user.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateSearchProfileSchema)) body: UpdateSearchProfileInput) {
    return this.profiles.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.profiles.remove(user.id, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.pause(user.id, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.resume(user.id, id);
  }
}
```

`apps/api/src/modules/me/me.module.ts` → `controllers: [MeController, SearchProfilesController]`, `providers: [MeRepository, MeService, LimitsService, SearchProfilesRepository, SearchProfilesService]`.

- [ ] **Step 3: Testleri çalıştır**

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/search-profiles.e2e.spec.ts test/isolation.e2e.spec.ts test/me.e2e.spec.ts && pnpm lint && pnpm --filter @oto/api typecheck`
Expected: PASS (lint: `me/**` altında `prisma.` yalnızca `*.repository.ts` içinde).

- [ ] **Step 4: Commit**

```bash
git add apps/api packages
git commit -m "feat(api): add search profile CRUD with plan limits, unverified cap and channel checks"
```

---

### Task 6: Profil önizlemesi ve `/me/matches`

**Files:**
- Create: `apps/api/src/modules/me/matches.repository.ts`, `apps/api/src/modules/me/matches.controller.ts`, `apps/api/test/matches.e2e.spec.ts`
- Modify: `apps/api/src/modules/me/search-profiles.repository.ts` (`preview`), `search-profiles.service.ts` (`preview`), `search-profiles.controller.ts` (`POST preview`), `me.module.ts`, `apps/api/test/isolation.e2e.spec.ts`, `apps/api/test/helpers.ts` (`seedListing`, `seedMatch`)

**Interfaces:**
- Consumes: `previewListings`, `countPreviewSince`, `MatchFilter` (`@oto/db`); `previewSearchProfileSchema`, `listMatchesQuerySchema`, `confidenceAtLeast` (`@oto/shared`).
- Produces:
  - `POST /me/search-profiles/preview` → `{ items: ListingCardView[] (≤20), estimatedDailyMatches: number }` (son 7 günde ilk görülen eşleşen ilan / 7, 1 ondalık).
  - `GET /me/matches` → `{ items: MatchView[], nextCursor: number | null }`.
  - `ListingCardView { id, title, make, model, year, km, city, price: string, imageUrl, url, firstSeenAt, analysis: { opportunityScore, confidence, discountPct: number|null, estimatedPrice: string|null } }`
  - `MatchView { id, reason, matchedPrice: string, createdAt, profile: { id, name }, listing: { id, title, make, model, year, km, city, price: string, imageUrl, url, status }, analysis: { opportunityScore, confidence, discountPct: number|null, estimatedPrice: string|null } }`
  - Test helpers: `seedListing(app, over?) → { listingId, analysisId }`, `seedMatch(app, userId, profileId, over?) → matchId`.

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/test/helpers.ts` sonuna:

```ts
let listingSeq = 0;
/** Demo kaynağı (yoksa) + ilan + analiz (latestAnalysisId bağlı) */
export async function seedListing(
  app: NestExpressApplication,
  over: { listing?: Record<string, unknown>; analysis?: Record<string, unknown> } = {},
): Promise<{ listingId: number; analysisId: number }> {
  const prisma = app.get(PrismaService);
  const source =
    (await prisma.dataSource.findUnique({ where: { code: 'test-src' } })) ??
    (await prisma.dataSource.create({ data: { code: 'test-src', name: 'T', adapterKey: 'demo', kind: 'HTTP', permissionType: 'TEST' } }));
  listingSeq += 1;
  const l = await prisma.listing.create({
    data: {
      sourceId: source.id, externalId: `A${listingSeq}`, url: `http://demo/${listingSeq}`, title: `İlan ${listingSeq}`,
      make: 'BMW', model: '3 Serisi', year: 2019, km: 85_000, fuel: 'GASOLINE', transmission: 'AUTOMATIC', city: 'İstanbul',
      price: 960_000n, contentHash: `h${listingSeq}`, ...over.listing,
    },
  });
  const a = await prisma.listingAnalysis.create({
    data: {
      listingId: l.id, engineVersion: 'rules-v1', estimatedPrice: 1_200_000n, priceDiff: 240_000n, discountPct: 0.2,
      opportunityScore: 77, comparableCount: 14, confidence: 'HIGH', flags: [], explanation: {}, comparableIds: [],
      listingPrice: l.price, ...over.analysis,
    },
  });
  await prisma.listing.update({ where: { id: l.id }, data: { latestAnalysisId: a.id } });
  return { listingId: l.id, analysisId: a.id };
}

export async function seedMatch(
  app: NestExpressApplication,
  userId: string,
  profileId: string,
  over: { listing?: Record<string, unknown>; analysis?: Record<string, unknown>; reason?: 'NEW' | 'PRICE_DROP' | 'RELIST' } = {},
): Promise<number> {
  const { listingId, analysisId } = await seedListing(app, over);
  const m = await app.get(PrismaService).listingMatch.create({
    data: { userId, searchProfileId: profileId, listingId, analysisId, reason: over.reason ?? 'NEW', matchedPrice: 960_000n },
  });
  return m.id;
}
```

`apps/api/test/matches.e2e.spec.ts`:

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, resetState, seedListing, seedMatch, verifyEmail } from './helpers';

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('POST /me/search-profiles/preview', () => {
  it('returns matching listings newest first with money as strings and a daily estimate', async () => {
    const A = await registerUser(app);
    const hit = await seedListing(app);
    await seedListing(app, { listing: { make: 'Audi', model: 'A4' } });
    await seedListing(app, { analysis: { confidence: 'INSUFFICIENT', discountPct: 0.4 } });
    const res = await A.agent.post('/api/v1/me/search-profiles/preview').send({ make: 'bmw', minDiscountPct: 0.1 });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([hit.listingId]);
    expect(res.body.items[0]).toMatchObject({ price: '960000', analysis: { confidence: 'HIGH', discountPct: 0.2, estimatedPrice: '1200000' } });
    expect(res.body.estimatedDailyMatches).toBe(0.1);
  });

  it('validates the filter', async () => {
    const A = await registerUser(app);
    expect((await A.agent.post('/api/v1/me/search-profiles/preview').send({ name: 'x' })).status).toBe(400);
  });
});

describe('GET /me/matches', () => {
  it('lists own matches with filters and cursor pagination', async () => {
    const A = await registerUser(app);
    await verifyEmail(app, A.user.id);
    const p1 = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'p1' })).body.id;
    const p2 = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'p2' })).body.id;
    const m1 = await seedMatch(app, A.user.id, p1, { analysis: { opportunityScore: 40, confidence: 'LOW' } });
    const m2 = await seedMatch(app, A.user.id, p1, { reason: 'PRICE_DROP' });
    const m3 = await seedMatch(app, A.user.id, p2);

    const all = await A.agent.get('/api/v1/me/matches');
    expect(all.body.items.map((m: { id: number }) => m.id)).toEqual([m3, m2, m1]);
    expect(all.body.items[0]).toMatchObject({ matchedPrice: '960000', profile: { id: p2, name: 'p2' }, listing: { price: '960000' } });
    expect(all.body.nextCursor).toBeNull();

    const page1 = await A.agent.get('/api/v1/me/matches?limit=2');
    expect(page1.body.items.map((m: { id: number }) => m.id)).toEqual([m3, m2]);
    const page2 = await A.agent.get(`/api/v1/me/matches?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((m: { id: number }) => m.id)).toEqual([m1]);

    expect((await A.agent.get(`/api/v1/me/matches?profileId=${p1}`)).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/v1/me/matches?reason=PRICE_DROP')).body.items.map((m: { id: number }) => m.id)).toEqual([m2]);
    expect((await A.agent.get('/api/v1/me/matches?minScore=60')).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/v1/me/matches?confidence=MEDIUM')).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/v1/me/matches?limit=500')).status).toBe(400);
  });
});
```

`apps/api/test/isolation.e2e.spec.ts` `CASES` içine (import'a `seedMatch` ekle):

```ts
  'POST /me/search-profiles/preview': async ({ A, B }) => {
    await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' });
    const res = await B.agent.post('/api/v1/me/search-profiles/preview').send({});
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(A.user.id);
  },
  'GET /me/matches': async ({ A, B }) => {
    const { id } = (await A.agent.post('/api/v1/me/search-profiles').send({ name: 'A' })).body;
    await seedMatch(app, A.user.id, id);
    expect((await A.agent.get('/api/v1/me/matches')).body.items).toHaveLength(1);
    expect((await B.agent.get('/api/v1/me/matches')).body.items).toEqual([]);
    expect((await B.agent.get(`/api/v1/me/matches?profileId=${id}`)).body.items).toEqual([]);
  },
```

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/matches.e2e.spec.ts test/isolation.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`search-profiles.repository.ts` → ekle (`previewListings`, `countPreviewSince`, `MatchFilter`, `PreviewListingRow` import'larıyla):

```ts
  /** Kişisel veri okumaz (ilanlar merkezi veridir); repository'de durur çünkü ham SQL çalıştırır. */
  async preview(filter: MatchFilter, limit: number, since: Date): Promise<{ rows: PreviewListingRow[]; recent: number }> {
    const [rows, recent] = await Promise.all([previewListings(this.prisma, filter, limit), countPreviewSince(this.prisma, filter, since)]);
    return { rows, recent };
  }
```

`search-profiles.service.ts` → ekle:

```ts
  async preview(input: PreviewSearchProfileInput, now = new Date()) {
    const p = withProfileDefaults({ name: 'önizleme', ...input });
    const filter: MatchFilter = {
      make: p.make, model: p.model, yearMin: p.yearMin, yearMax: p.yearMax,
      priceMin: p.priceMin === null ? null : BigInt(p.priceMin), priceMax: p.priceMax === null ? null : BigInt(p.priceMax),
      kmMax: p.kmMax, fuels: p.fuels, transmissions: p.transmissions, cities: p.cities, excludeDamaged: p.excludeDamaged,
      minDiscountPct: p.minDiscountPct, minConfidence: p.minConfidence,
    };
    const { rows, recent } = await this.repo.preview(filter, 20, new Date(now.getTime() - 7 * 86_400_000));
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, make: r.make, model: r.model, year: r.year, km: r.km, city: r.city, price: r.price.toString(),
        imageUrl: r.imageUrl, url: r.url, firstSeenAt: r.firstSeenAt,
        analysis: {
          opportunityScore: r.opportunityScore, confidence: r.confidence,
          discountPct: r.discountPct === null ? null : Number(r.discountPct), estimatedPrice: r.estimatedPrice?.toString() ?? null,
        },
      })),
      estimatedDailyMatches: Math.round((recent / 7) * 10) / 10,
    };
  }
```

`search-profiles.controller.ts` → **`@Get(':id')`'den önce** ekle:

```ts
  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodPipe(previewSearchProfileSchema)) body: PreviewSearchProfileInput) {
    return this.profiles.preview(body);
  }
```

`apps/api/src/modules/me/matches.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { confidenceAtLeast, type ListMatchesQuery } from '@oto/shared';
import { PrismaService } from '../../infra/prisma.service';

@Injectable()
export class MatchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, q: ListMatchesQuery) {
    return this.prisma.listingMatch.findMany({
      where: {
        userId,
        ...(q.profileId ? { searchProfileId: q.profileId } : {}),
        ...(q.reason ? { reason: q.reason } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        ...(q.minScore !== undefined || q.confidence
          ? {
              analysis: {
                ...(q.minScore !== undefined ? { opportunityScore: { gte: q.minScore } } : {}),
                ...(q.confidence ? { confidence: { in: confidenceAtLeast(q.confidence) } } : {}),
              },
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      include: {
        searchProfile: { select: { id: true, name: true } },
        listing: { select: { id: true, title: true, make: true, model: true, year: true, km: true, city: true, price: true, imageUrl: true, url: true, status: true } },
        analysis: { select: { opportunityScore: true, confidence: true, discountPct: true, estimatedPrice: true } },
      },
    });
  }
}
```

`apps/api/src/modules/me/matches.controller.ts`:

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { listMatchesQuerySchema, type ListMatchesQuery } from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { MatchesRepository } from './matches.repository';

@Controller('me/matches')
export class MatchesController {
  constructor(private readonly matches: MatchesRepository) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listMatchesQuerySchema)) q: ListMatchesQuery) {
    const rows = await this.matches.list(user.id, q);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((m) => ({
        id: m.id,
        reason: m.reason,
        matchedPrice: m.matchedPrice.toString(),
        createdAt: m.createdAt,
        profile: m.searchProfile,
        listing: { ...m.listing, price: m.listing.price.toString() },
        analysis: {
          opportunityScore: m.analysis.opportunityScore,
          confidence: m.analysis.confidence,
          discountPct: m.analysis.discountPct === null ? null : Number(m.analysis.discountPct),
          estimatedPrice: m.analysis.estimatedPrice?.toString() ?? null,
        },
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  }
}
```

`me.module.ts` → `controllers`'a `MatchesController`, `providers`'a `MatchesRepository`.

- [ ] **Step 3: Testleri çalıştır**

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts && pnpm lint && pnpm --filter @oto/api typecheck`
Expected: PASS (izolasyon kapsama testi dahil).

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): add search profile preview and /me/matches with cursor pagination"
```

---

### Task 7: Auth taşınan maddeleri (doğrulama yeniden gönderimi, şifre onayı sınırlayıcı, ESLint sertleştirme)

**Files:**
- Create: `apps/api/src/modules/auth/password-confirmation.service.ts`, `apps/api/test/auth-carryover.e2e.spec.ts`
- Modify: `apps/api/src/modules/auth/email-verification.service.ts`, `auth.controller.ts`, `auth.module.ts`, `packages/shared/src/schemas/auth.ts` (`resendVerificationSchema`), `apps/api/src/modules/me/me.service.ts`, `apps/api/src/modules/me/me.repository.ts` (kullanılmayan `findPasswordHash` silinir), `eslint.config.mjs`, `apps/api/test/lint/me-prisma-rule.spec.ts`

**Interfaces:**
- Produces:
  - `POST /auth/resend-verification {email}` → her zaman 204; e-posta başına 60 sn bekleme (Redis `SET NX EX 60`); yalnızca ACTIVE ve doğrulanmamış kullanıcıya gönderilir; önceki kullanılmamış doğrulama token'ları geçersiz kılınır.
  - `PasswordConfirmationService.assert(userId: string, password: string): Promise<void>` — 15 dk'da 5 hatalı denemeden sonra 429 `RATE_LIMITED`; hata → 400 `INVALID_CREDENTIALS`; başarı sayacı sıfırlar. `AuthModule` export eder.
  - ESLint `me/**` kuralı: `prisma` destructuring ve `new PrismaClient` / `PrismaClient` tanımlayıcısı da yasak.

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/test/auth-carryover.e2e.spec.ts`:

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, newAgent, registerUser, resetState, tokenFromMail } from './helpers';

let app: NestExpressApplication;
const flush = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

describe('POST /auth/resend-verification', () => {
  it('always 204; sends once per cooldown only to unverified active users; old token invalidated', async () => {
    const A = await registerUser(app);
    await flush();
    const outbox = app.get(MailService).outbox;
    const firstToken = tokenFromMail(outbox[0].text);
    outbox.length = 0;

    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: 'nobody@test.com' })).status).toBe(204);
    await flush();
    expect(outbox).toHaveLength(1);

    expect((await newAgent(app).post('/api/v1/auth/verify-email').send({ token: firstToken })).status).toBe(400);
    expect((await newAgent(app).post('/api/v1/auth/verify-email').send({ token: tokenFromMail(outbox[0].text) })).status).toBe(204);
    expect((await app.get(PrismaService).user.findUniqueOrThrow({ where: { id: A.user.id } })).emailVerifiedAt).not.toBeNull();

    // Doğrulanmış kullanıcıya gönderilmez (bekleme süresi dolmuş olsa bile)
    outbox.length = 0;
    await app.get(RedisService).del(`auth:resend:${A.email.toLowerCase()}`);
    expect((await newAgent(app).post('/api/v1/auth/resend-verification').send({ email: A.email })).status).toBe(204);
    await flush();
    expect(outbox).toHaveLength(0);
  });
});

describe('password confirmation limiter', () => {
  it('locks sensitive /me actions after 5 wrong passwords', async () => {
    const A = await registerUser(app);
    for (let i = 0; i < 5; i++) {
      const r = await A.agent.post('/api/v1/me/change-password').send({ currentPassword: 'wrong-password-x', newPassword: 'another-strong-pass' });
      expect(r.status).toBe(400);
    }
    const locked = await A.agent.post('/api/v1/me/change-password').send({ currentPassword: A.password, newPassword: 'another-strong-pass' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect((await A.agent.delete('/api/v1/me').send({ password: A.password })).status).toBe(429);
  });
});
```

`apps/api/test/lint/me-prisma-rule.spec.ts` → ekle:

```ts
  it('forbids destructuring prisma and constructing PrismaClient in /me', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const bad = [
      `export class X { constructor(private readonly db: { prisma: unknown }) {} run() { const { prisma } = this.db; return prisma; } }\n`,
      `import { PrismaClient } from '@oto/db';\nexport const c = new PrismaClient();\n`,
    ];
    for (const src of bad) {
      const [result] = await eslint.lintText(src, { filePath: resolve(repoRoot, 'apps/api/src/modules/me/bad2.service.ts') });
      expect(result.messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
    }
  });
```

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/auth-carryover.e2e.spec.ts && pnpm --filter @oto/api exec vitest run test/lint` → FAIL.

- [ ] **Step 2: Uygula**

`packages/shared/src/schemas/auth.ts` → `forgotPasswordSchema` yanına (aynı e-posta şemasını kullanarak):

```ts
export const resendVerificationSchema = z.object({ email: emailSchema }).strict();
```
(`emailSchema` dosyadaki mevcut e-posta şemasının adıdır; farklıysa onu kullan.) `pnpm --filter @oto/shared build`.

`email-verification.service.ts` → `RedisService` enjekte et ve ekle:

```ts
  /** Kullanıcının var olup olmadığını sızdırmaz; e-posta başına 60 sn'de bir gönderir. */
  async resend(email: string): Promise<void> {
    const key = `auth:resend:${email.toLowerCase()}`;
    if ((await this.redis.set(key, '1', 'EX', 60, 'NX')) !== 'OK') return;
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || user.emailVerifiedAt) return;
    await this.prisma.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await this.sendFor(user);
  }
```

`auth.controller.ts` → ekle:

```ts
  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@Body(new ZodPipe(resendVerificationSchema)) body: { email: string }) {
    await this.verification.resend(body.email);
  }
```

`apps/api/src/modules/auth/password-confirmation.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@oto/shared';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import { PasswordService } from './password.service';

const MAX_FAILURES = 5;
const WINDOW_SEC = 15 * 60;

/** Hassas /me işlemleri (şifre değişimi, hesap silme) için mevcut şifre onayı; deneme sınırlıdır. */
@Injectable()
export class PasswordConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly passwords: PasswordService,
  ) {}

  async assert(userId: string, password: string): Promise<void> {
    const key = `auth:confirm-fail:${userId}`;
    if (Number((await this.redis.get(key)) ?? 0) >= MAX_FAILURES) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Çok fazla hatalı deneme. Lütfen 15 dakika sonra tekrar deneyin');
    }
    const u = await this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } }, select: { passwordHash: true } });
    if (!u?.passwordHash || !(await this.passwords.verify(u.passwordHash, password))) {
      await this.redis.multi().incr(key).expire(key, WINDOW_SEC, 'NX').exec();
      throw Errors.invalidCredentials(400);
    }
    await this.redis.del(key);
  }
}
```

`auth.module.ts` → `providers` ve `exports`'a `PasswordConfirmationService` ekle.

`me.service.ts` → `assertPassword` özel metodunu sil; `changePassword` ve `deleteAccount` içinde `await this.confirm.assert(userId, password)` kullan (`PasswordConfirmationService` enjekte edilir). `me.repository.ts`'teki `findPasswordHash` artık kullanılmıyorsa sil.

`eslint.config.mjs` → `me/**` bloğunun `no-restricted-syntax` listesine ekle:

```js
        {
          selector: "ObjectPattern > Property[key.name='prisma']",
          message: '/me modüllerinde prisma destructuring yasaktır; *.repository.ts kullanın.',
        },
        {
          selector: "Identifier[name='PrismaClient']",
          message: '/me modüllerinde PrismaClient kullanılamaz; *.repository.ts kullanın.',
        },
```

- [ ] **Step 3: Testleri çalıştır**

Run: `pnpm --filter @oto/api test && pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts && pnpm lint && pnpm typecheck`
Expected: PASS (mevcut `me.e2e` şifre testleri dahil).

- [ ] **Step 4: Commit**

```bash
git add apps/api packages/shared eslint.config.mjs
git commit -m "feat(auth): resend verification, rate-limited password confirmation, harden /me lint rule"
```

---

### Task 8: Yeni externalId ile yeniden yayın sezgisi (ingest)

**Files:**
- Create: `packages/db/prisma/migrations/20261013000001_relist_index/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (Listing indeksi), `apps/worker/src/collection/ingest.service.ts`, `apps/worker/test/ingest.e2e.spec.ts` (yoksa ingest testlerinin bulunduğu dosya)

**Interfaces:**
- Consumes: `IngestService.ingest` (mevcut).
- Produces: `IngestService.ingest` yeni externalId için ikiz bulursa `outcome: 'RELISTED'` ve **eski** `listingId` döner; ikizin `externalId`'si yenisiyle değişir.

- [ ] **Step 1: Başarısız testi yaz**

Ingest e2e dosyasına (mevcut `NormalizedListing` fabrika yardımcısını kullan; adı farklıysa ona uyarla) ekle:

```ts
  describe('relist with a new externalId', () => {
    it('reuses a recently removed twin (same title, km, year) as RELIST', async () => {
      const seen = new Date();
      const first = await ingest.ingest(sourceId, normalized({ externalId: 'OLD-1', title: 'Temiz 320i', km: 85_000, year: 2019 }), seen);
      await prisma.listing.update({ where: { id: first.listingId }, data: { status: 'REMOVED', removedAt: new Date(seen.getTime() - 2 * 86_400_000) } });
      const again = await ingest.ingest(sourceId, normalized({ externalId: 'NEW-9', title: 'Temiz 320i', km: 85_000, year: 2019, price: 900_000n }), seen);
      expect(again).toEqual({ outcome: 'RELISTED', listingId: first.listingId });
      const row = await prisma.listing.findUniqueOrThrow({ where: { id: first.listingId } });
      expect(row).toMatchObject({ externalId: 'NEW-9', status: 'ACTIVE' });
      expect(row.relistedAt).not.toBeNull();
      expect(await prisma.listing.count()).toBe(1);
    });

    it('does not reuse twins removed more than 7 days ago or with different km', async () => {
      const seen = new Date();
      const old = await ingest.ingest(sourceId, normalized({ externalId: 'OLD-2', title: 'X', km: 1000, year: 2019 }), seen);
      await prisma.listing.update({ where: { id: old.listingId }, data: { status: 'REMOVED', removedAt: new Date(seen.getTime() - 8 * 86_400_000) } });
      expect((await ingest.ingest(sourceId, normalized({ externalId: 'NEW-2', title: 'X', km: 1000, year: 2019 }), seen)).outcome).toBe('NEW');
      const other = await ingest.ingest(sourceId, normalized({ externalId: 'OLD-3', title: 'Y', km: 1000, year: 2019 }), seen);
      await prisma.listing.update({ where: { id: other.listingId }, data: { status: 'REMOVED', removedAt: seen } });
      expect((await ingest.ingest(sourceId, normalized({ externalId: 'NEW-3', title: 'Y', km: 1001, year: 2019 }), seen)).outcome).toBe('NEW');
    });
  });
```

Run ingest e2e dosyası → FAIL (outcome 'NEW').

- [ ] **Step 2: Uygula**

`schema.prisma` → `Listing` modeline: `@@index([sourceId, status, year, km])`. Migration klasörünü `pnpm --filter @oto/db exec prisma migrate dev --create-only --name relist_index` ile üret (dev DB 5433 açık olmalı; açık değilse SQL'i elle yaz: `CREATE INDEX "Listing_sourceId_status_year_km_idx" ON "Listing"("sourceId", "status", "year", "km");`) ve klasör adını `20261013000001_relist_index` yap. `pnpm --filter @oto/db build`.

`ingest.service.ts`:

```ts
const RELIST_TWIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
```

`ingest()` içinde `if (!existing) {` bloğunun **başına**:

```ts
      const twin = await this.findRelistTwin(sourceId, l, seenAt);
      if (twin) {
        try {
          await this.prisma.listing.update({ where: { id: twin.id }, data: { externalId: l.externalId } });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        return this.ingest(sourceId, l, seenAt);
      }
```

Sınıfa:

```ts
  /** Spec §5.1: aynı kaynak + başlık + km + yıl ve son 7 günde kaldırılmış ilan → yeni externalId ile yeniden yayın. */
  private findRelistTwin(sourceId: number, l: NormalizedListing, seenAt: Date) {
    return this.prisma.listing.findFirst({
      where: {
        sourceId, status: 'REMOVED', year: l.year, km: l.km, title: l.title,
        removedAt: { gte: new Date(seenAt.getTime() - RELIST_TWIN_WINDOW_MS) },
      },
      orderBy: { removedAt: 'desc' },
      select: { id: true },
    });
  }
```

(Özyinelemeli çağrı ikizi `existing` olarak bulur ve mevcut `relisted` yolunu izler: `status ACTIVE`, `relistedAt`, `RELIST` analizi.)

- [ ] **Step 3: Testleri çalıştır**

Run: `pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts && pnpm --filter @oto/db test:e2e && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db apps/worker
git commit -m "feat(worker): treat a recently removed twin with a new externalId as a relist"
```

---

### Task 9: Uçtan uca hat (tarama → analiz → eşleşme), dokümantasyon, smoke test

**Files:**
- Modify: `apps/worker/test/pipeline.e2e.spec.ts`, `.env.example`, `README.md`, `docs/architecture.md`, `docs/superpowers/plans/2026-10-10-00-roadmap.md`
- Create: `docs/matching.md`

**Interfaces:**
- Consumes: tüm önceki task'lar.

- [ ] **Step 1: Pipeline testini genişlet**

`apps/worker/test/pipeline.e2e.spec.ts`:
- `ProcessorTestModule`'e `MatchingModule` import'u ve `MatchWorkerHost` + `{ provide: MATCH_WORKER_AUTOSTART, useValue: false }` ekle; `afterAll`'da `onModuleDestroy()`.
- Plan 03'ün "analyzes scraped listings and emits a NEW match event for an injected deal" testinde, demo fırsatı enjekte edilmeden **önce**: `createUser` + `createProfile(ref, user.id, { make: <enjekte edilen fırsatın markası>, minDiscountPct: 0.1, minConfidence: 'LOW' })`; analiz worker'ı ile birlikte `ref.get(MatchWorkerHost).start()`.
- Testin sonunda:

```ts
    const match = await waitFor(() => prisma.listingMatch.findFirst({ where: { listingId: deal.id, searchProfileId: profile.id } }));
    expect(match.reason).toBe('NEW');
    expect(match.matchedPrice).toBe(deal.price);
```

(`deal` testte fırsat ilanının değişken adıdır; farklıysa uyarla. Analiz worker'ı neden testin içinde başlatılıyorsa — Plan 03 kararı — eşleştirme worker'ını da aynı yerde başlat.)

Run: `pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts test/pipeline.e2e.spec.ts` → PASS (gerekirse 3 kez çalıştırıp kararlılığı doğrula; kararsızsa kök nedeni bul, süre artırma).

- [ ] **Step 2: Dokümantasyon**

`docs/matching.md` (Türkçe) şunları anlatır: tek eşleştirme koşulu ve iki yönü (`matchPredicate`), `fold_tr` ve `confidence_rank`, profil başına neden tablosu (`decideMatchReason` örnekleriyle), idempotentlik katmanları (advisory kilit, benzersiz anahtar, son eşleşme kontrolü), sırasız olay örneği, profil limitleri (plan, override, doğrulanmamış hesap, sürdürme), önizlemenin anlamı (`estimatedDailyMatches`), yeni externalId ile yeniden yayın sezgisi, Plan 05'e bırakılanlar (bildirim kaydı, günlük sayaç, kanal doğrulaması).

`docs/architecture.md` → akış şemasına `match` tüketicisi ve `ListingMatch`'i ekle; `README.md` ve `.env.example` → `MATCH_CONCURRENCY=4`.

Yol haritasına `## Plan 04 sonrası taşınan maddeler` bölümü ekle (en az):
- **Plan 05:** `MatchService.process` dönüşündeki `created[]` için `Notification` kayıtları + `notify` işleri (profil kanalları; TELEGRAM yalnızca doğrulanmış ve etkin kanal varsa); günlük bildirim sayacı (Redis `INCR` + İstanbul gece yarısı TTL, DB mutabakatı) ve `SKIPPED_LIMIT`; doğrulanmamış hesap Telegram bağlayamaz; `latencyMs = sentAt − listing.firstSeenAt`. Eşleştirme ve bildirim kaydı aynı transaction'da olmalı ya da eşleşme için kalıcı "bildirim oluşturuldu" işareti tutulmalı (worker eşleşmeyi yazıp bildirimden önce çökerse yeniden denenen iş `ON CONFLICT` nedeniyle `created` boş döner — bildirim kaybolmasın).
- **Plan 06:** profil formu için `/catalog/makes` ve `/catalog/makes/:make/models`; `/me/matches` skor sıralaması gerekiyorsa eklenmeli; `/me/listings/:id`, `/me/opportunities`, `/me/dashboard`.
- **Plan 07:** admin plan değişikliğinde fazla profillerin davranışı (şu an: sürdürme engellenir, mevcut ACTIVE fazlalar çalışmaya devam eder) — admin plan düşürmede fazlayı otomatik PAUSED yapmalı.
- **Borç:** aynı fiyatta ikinci RELIST benzersiz anahtar nedeniyle bildirilmez (ör. aylar sonra aynı fiyatla yeniden yayın).
- Plan 03 sonrası Plan 04 maddelerini "tamamlandı" olarak işaretle (yapılmayan varsa açıkça kalsın).

- [ ] **Step 3: Tüm doğrulama**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm --filter @oto/worker build && pnpm --filter @oto/api build`
Expected: PASS.

- [ ] **Step 4: Canlı smoke test**

Dev compose (Postgres 5433, Redis 6380) açık; `pnpm --filter @oto/db migrate:deploy && pnpm --filter @oto/db seed`. DEMO_SIZE=2000 ile demo-site, scheduler ve worker'ı arka planda başlat; API'yi başlat. Bir kullanıcı kaydet (curl, `X-Requested-With` başlığıyla), e-postayı DB'den doğrula, `minDiscountPct: 0.1, minConfidence: 'LOW'` ve `minDiscountPct: 0` olmak üzere iki profil oluştur, önizlemeyi çağır, bir tarama turu sonrası `GET /me/matches` sonucunu ve `ListingMatch` sayılarını raporla. Bitince başlattığın tüm süreçleri durdur.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/test/pipeline.e2e.spec.ts docs README.md .env.example
git commit -m "test(worker): extend pipeline through matching; document matching and profiles"
```
