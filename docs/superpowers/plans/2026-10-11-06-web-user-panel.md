# Plan 06 — Web + Kullanıcı Paneli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI task'larında (5–11) uygulayıcı ayrıca `frontend-design:frontend-design` skill'ini yüklemelidir.

**Goal:** Kullanıcı panelini ("Gece Showroom") gerçek API'ye bağlı, çalışan bir Next.js uygulaması olarak sunmak: giriş/kayıt akışları, dashboard, fırsatlar, ilan detayı (fiyat bandı, fiyat geçmişi, "Fiyat nasıl hesaplandı?"), arama profilleri (canlı önizlemeli sihirbaz), eşleşmeler, favoriler, canlı bildirimler (zil + sayfa), abonelik ve ayarlar (oturumlar, Telegram bağlama); bunun için eksik `/me` ve `/catalog` uç noktalarını tamamlamak.

**Architecture:** API tarafında `/catalog/*`, `/me/opportunities`, `/me/listings/:id`, `/me/favorites`, `/me/subscription`, `/me/dashboard` mevcut desenle (`*.repository.ts` + zod + izolasyon matrisi) eklenir; yanıt sözleşmeleri `@oto/shared`'da zod şemalarıdır. Web `apps/web` (Next.js 15 App Router, React 19): kabuk ve sayfa iskeleti RSC, kimlik doğrulamalı veri istemci tarafında TanStack Query + tipli `apiFetch` (çerez, `X-Requested-With`, 401'de tek seferlik refresh). Geliştirmede Next `rewrites` `/api/*` isteklerini API'ye aktarır (tek origin, first-party çerez; prod'da Caddy aynı işi yapar). Canlı bildirimler `EventSource` ile SSE'ye bağlanır (`ready {unreadCount,lastId}` sözleşmesi, 15 dk'da yeniden bağlanma).

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v4, Radix UI primitifleri (shadcn/ui deseninde elle yazılmış bileşenler), lucide-react, Recharts, motion (Framer Motion), sonner, TanStack Query v5, react-hook-form + zod; Vitest + Testing Library + MSW (web), Vitest + Supertest (api).

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md` §7 (`/me/*`, `/catalog/*`), §8 (Sayfalar — Kullanıcı, Görsel yön, İmza bileşenleri), §6 (oturum/CSRF). Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md` (Plan 03/04/05 sonrası "Plan 06" maddeleri). Sözleşmeler: `docs/analysis-engine.md`, `docs/matching.md`, `docs/notifications.md`.

## Bu planın kararları (spec'i netleştiren)

| Konu | Karar | Gerekçe |
|---|---|---|
| Yönlendirme | Kullanıcı paneli `/app/*`; kimlik sayfaları `/giris`, `/kayit`, `/sifremi-unuttum`, `/reset-password`, `/verify-email` (API e-posta bağlantıları bu yolları kullanır); `/ilan/:id` → `/app/ilan/:id` (Telegram "Analizi gör") | Spec §8; Plan 05 notu |
| Tek origin | Dev'de `next.config` `rewrites`: `/api/:path*` → `${API_ORIGIN}/api/:path*` (varsayılan `http://localhost:3001`); prod'da Caddy | Spec §6 "first-party cookie, CORS yok"; CSRF Origin kontrolü `PUBLIC_BASE_URL` = web origin'i |
| Veri çekme | Kimlikli veriler istemci bileşenlerinde TanStack Query; RSC yalnızca kabuk/statik içerik. `middleware.ts` çerez yoksa `/app/*` → `/giris?next=…` | Erişim token'ı 15 dk; refresh çerezi yalnızca `/api/v1/auth` yolunda — sunucu tarafı yenileme karmaşası yok |
| Refresh | `apiFetch` 401 (`UNAUTHENTICATED`/`TOKEN_INVALID`) alırsa tek uçuşta (paylaşılan promise) `POST /auth/refresh`; başarılıysa isteği bir kez yeniler; değilse `/giris`'e yönlendirir. `REFRESH_RACE` → 300 ms sonra bir kez yeniden dener | Spec §6 rotasyon + yarış hatası |
| Fırsatlar | `GET /me/opportunities`: ACTIVE, son analiz skor ≥ 60 ve güven ≥ MEDIUM (varsayılan; `minScore`/`confidence` ile daraltılabilir, gevşetilemez), `firstSeenAt ≤ now − opportunitiesDelayHours`; sıralama `score` (varsayılan) \| `recent` \| `discount`; opak cursor (base64url JSON) | Spec §7 |
| İlan detayı | `GET /me/listings/:id`: ilan (REMOVED dahil), son analiz (açıklama + bant istatistikleri), fiyat geçmişi, emsaller (en fazla 30, `explanation.comparables` ile listing başlık/şehir/url birleştirilmiş), `isFavorite`, kullanıcının bu ilandaki eşleşmeleri | Spec §7, §8 |
| Fiyat bandı | Q1–medyan–Q3 `explanation.stats`'tan; eksen = [min(Q1, fiyat) × 0,9, max(Q3, fiyat) × 1,1]; INSUFFICIENT/istatistik yoksa bant yerine "Zayıf tahmin — yeterli emsal yok" metni (`insufficientReason`'a göre açıklama) | Spec §8; Plan 03 notu |
| "Hasarlı dışlanan" | Açıklama paneli `pool.damagedExcluded` yerine `comparables.filter(c => c.damaged && !c.outlier)` gibi türetilmiş sayıları gösterir (çift saymayı önler) | Plan 03 notu |
| Katalog | `GET /catalog/makes` ve `/catalog/makes/:make/models`: ACTIVE ilanlardaki benzersiz değerler + ilan sayısı, Redis'te 10 dk önbellek; kimlik doğrulaması gerekir | Spec §7; profil formu |
| Dashboard | `GET /me/dashboard`: son 8 eşleşme (fırsat kartı biçiminde), aktif/toplam profil, bugünkü harici bildirim/limit, son 7 İstanbul günü için günlük eşleşme serisi | Spec §7 |
| Bildirim zili | SSE `ready` → sayaç = `unreadCount`, `lastId` saklanır; `notification` olayında `id > lastId` ve kanal IN_APP ise sayaç +1 ve toast; her `ready`/yeniden bağlanmada liste sorgusu geçersiz kılınır; akış kapanınca (15 dk veya hata) 1 sn → 30 sn üstel bekleme ile yeniden bağlan, önce `/auth/refresh`; çıkışta akış kapatılır | Plan 05 sözleşmesi |
| Bildirim yağmuru | Toast'lar 5 sn'de en fazla 3; fazlası tek "+N yeni eşleşme" toast'unda toplanır; bildirim sayfası aynı ilan için ardışık kayıtları gruplamaz (MVP), ama "Tümünü okundu yap" sunar | Plan 05 smoke gözlemi |
| Profil formu | `minDiscountPct = 0` iken `minConfidence` alanı gizli + açıklama ("Yeni ilan takibi: güven koşulu uygulanmaz"); doğrulanmamış hesapta tek profil uyarısı; limit hatası (`LIMIT_REACHED`) yükseltme çağrısıyla gösterilir | Plan 04 notları |
| Telegram | Ayarlar → Kanallar: `telegramAvailable=false` ise devre dışı kart + açıklama; bağla → `deepLink` + 10 dk geri sayım + "Bağlandı" durumunu SSE `SECURITY TELEGRAM_LINKED` olayı ya da 5 sn'lik `/me/channels` yoklaması ile algılama | Plan 05 notu |
| Tema | Koyu varsayılan; sistem tercihi + kullanıcı seçimi (`localStorage` `theme`), `<html data-theme>`; FOUC'u önleyen satır içi script | Spec §8 |
| Fontlar | `next/font/google`: Instrument Sans (başlık), Inter (gövde), Geist Mono (sayı), `latin` + `latin-ext` alt kümeleri | Spec §8 Türkçe glif |
| Hareket | `motion`; yeni fırsat kartı tek seferlik amber parıltı (1,2 sn), zil sayacı sayarak artar; `prefers-reduced-motion`'da animasyon yok | Spec §8 |
| Test | Web: bileşen ve hook testleri (Vitest + Testing Library + MSW); sayfa akışları MSW ile. Uçtan uca Playwright Plan 08'de; bu planda yalnızca ekran görüntüsü smoke'u | Spec §10 |

## Global Constraints

- Plan 01–05 Global Constraints maddeleri geçerlidir.
- Para JSON'da rakam dizgisi; UI'da `960.000 ₺` (Geist Mono, tabular-nums); indirim `%20 altında`; tarihler UI'da Europe/Istanbul.
- Renkler (CSS değişkeni token'ları): zemin `#0E0F11`, vurgu `#E8A35C` (yalnızca fırsat/skor/birincil aksiyon), pozitif sakin yeşil, uyarı kırmızı; açık tema tam destekli. AA kontrast; renge ek olarak metin etiketi.
- Tipografi: başlık Instrument Sans, gövde Inter, sayılar Geist Mono.
- Erişilebilirlik: tam klavye gezinmesi, görünür odak halkası, `aria-*` etiketleri, `prefers-reduced-motion`.
- Mobil: sidebar → drawer, tablolar → kart listesi (≤ 768 px).
- `/me/**` API veri erişimi yalnızca `*.repository.ts`; her yeni `/me` route'u izolasyon matrisine eklenir.
- Sayfalama ≤ 100; cursor'lar opak; yabancı kaynak → 404.
- Mutasyonlar `X-Requested-With: XMLHttpRequest` başlığı ile; çerezler `credentials: 'include'`.
- Kaynak etiği: scraping kısıtlarını aşan davranış eklenmez; ilan dış bağlantıları `rel="noopener noreferrer nofollow"` ve yeni sekmede açılır.

## Review Focus

1. **Oturum süresi dolduğunda açık sayfa:** İstekler sessizce yenilenir; refresh de başarısızsa kullanıcı `next` parametresiyle girişe yönlenir, veri kaybı uyarısı olmadan sonsuz döngü olmaz. → Task 5 testi.
2. **Zayıf/eksik analiz (INSUFFICIENT, tahmin null, istatistik null, fiyat bant dışında):** Fiyat bandı çökmez, "Zayıf tahmin" etiketi ve sebebi görünür; fiyat işaretçisi eksen sınırında kırpılır. → Task 6 testi.
3. **Canlı bildirim akışı kopması / 15 dk kapanma / çıkış:** Sayaç çift saymaz, yeniden bağlanır, çıkışta bağlantı kapanır. → Task 8 testi.
4. **Limit ve doğrulama hataları (profil limiti, doğrulanmamış hesap, plan Telegram içermiyor, Telegram kapalı):** Kullanıcı anlaşılır Türkçe mesaj ve yönlendirme görür, form verisi kaybolmaz. → Task 10 ve 11 testleri.
5. **Kaldırılmış ilan / başkasına ait favori / var olmayan ilan id'si:** Detay sayfası REMOVED rozetiyle açılır; yabancı/olmayan kaynak 404 sayfası gösterir. → Task 2 ve 9 testleri.

## Dosya Haritası

```
packages/shared/src/schemas/panel.ts (+ spec)            yanıt/istek şemaları: opportunities, listing detail, favorites, dashboard, catalog, subscription
apps/api/src/modules/catalog/{catalog.module,catalog.controller,catalog.repository}.ts
apps/api/src/modules/me/{opportunities.repository,opportunities.controller,listings.repository,listings.controller,
                          favorites.repository,favorites.controller,dashboard.repository,dashboard.controller,subscription.controller,listing-card.view}.ts
apps/api/test/{panel.e2e.spec,favorites.e2e.spec,catalog.e2e.spec}.ts, isolation.e2e.spec.ts
apps/web/  (yeni Next.js uygulaması)
  next.config.mjs, postcss.config.mjs, tsconfig.json, vitest.config.ts, vitest.setup.ts, middleware.ts, package.json
  src/app/  layout.tsx, globals.css, (auth)/{giris,kayit,sifremi-unuttum,reset-password,verify-email}/page.tsx,
            ilan/[id]/page.tsx (yönlendirme), app/{layout,page}.tsx (dashboard), app/firsatlar, app/ilan/[id], app/profiller(+/yeni,+/[id]),
            app/eslesmeler, app/favoriler, app/bildirimler, app/abonelik, app/ayarlar/{page,guvenlik,kanallar}, not-found.tsx
  src/lib/   api.ts (apiFetch, ApiError), queries.ts (query key'leri + hook'lar), format.ts, sse.ts (useNotificationStream), theme.ts, cn.ts
  src/components/ ui/* (button, input, select, switch, dialog, dropdown, tabs, tooltip, badge, skeleton, card, sheet),
                  price-band.tsx, score-ring.tsx, confidence-meter.tsx, listing-card.tsx, listing-table.tsx, price-history-chart.tsx,
                  explanation-panel.tsx, notification-bell.tsx, app-shell.tsx, theme-toggle.tsx, profile-wizard.tsx, empty-state.tsx
  src/test/  msw handlers, render helper
docs/web.md (yeni), README.md, docs/architecture.md, roadmap
```

---

### Task 1: Paylaşılan panel sözleşmeleri

**Files:**
- Create: `packages/shared/src/schemas/panel.ts`, `packages/shared/src/panel.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces (zod + tip):
  - `analysisSummarySchema` / `AnalysisSummary`: `{ opportunityScore: number; confidence: 'INSUFFICIENT'|'LOW'|'MEDIUM'|'HIGH'; estimatedPrice: string|null; priceDiff: string|null; discountPct: number|null; comparableCount: number; band: { q1: string|null; median: string|null; q3: string|null }; flags: string[]; insufficientReason: 'NONE'|'NO_LEVEL'|'AFTER_OUTLIERS'|'INVALID_TARGET' }`
  - `listingCardSchema` / `ListingCard`: `{ id: number; title: string; make: string; model: string; trim: string|null; year: number; km: number; fuel: string; transmission: string; city: string|null; price: string; imageUrl: string|null; url: string; status: 'ACTIVE'|'REMOVED'; firstSeenAt: string; analysis: AnalysisSummary|null; isFavorite: boolean }`
  - `opportunitiesQuerySchema` (strict; `make?`, `model?`, `city?`, `maxPrice?` (rakam dizgisi), `minScore?` 60..100, `confidence?` `'MEDIUM'|'HIGH'`, `sort` `'score'|'recent'|'discount'` (varsayılan `score`), `cursor?` (≤ 512 karakter base64url), `limit` 1..50 varsayılan 24)
  - `listingDetailSchema` / `ListingDetail`: `ListingCard & { lastSeenAt: string; removedAt: string|null; damageInfo: { tramerAmount?: number; paintedParts?: string[]; changedParts?: string[] } | null; bodyType: string|null; color: string|null; sellerType: string|null; priceHistory: Array<{ price: string; km: number; observedAt: string }>; explanation: unknown | null; comparables: Array<{ id: number; title: string; city: string|null; url: string; year: number; km: number; price: string; adjusted: string; damaged: boolean; outlier: boolean; clamped: boolean; status: 'ACTIVE'|'REMOVED' }>; myMatches: Array<{ id: number; reason: 'NEW'|'PRICE_DROP'|'RELIST'; matchedPrice: string; createdAt: string; profile: { id: string; name: string } }> }`
  - `favoritesQuerySchema` (`cursor?` 1..2147483647, `limit` 1..100 varsayılan 24), `putFavoriteSchema` (`{ note?: string (≤ 280, trim) | null }` strict), `FavoriteItem` = `{ listing: ListingCard; note: string|null; createdAt: string }`
  - `dashboardSchema` / `Dashboard`: `{ recentMatches: Array<{ id: number; reason; createdAt: string; profile: { id; name }; listing: ListingCard }>; profiles: { active: number; total: number; max: number }; notifications: { today: number; limit: number }; series: Array<{ day: string /* YYYY-MM-DD İstanbul */; matches: number }> /* 7 eleman, eskiden yeniye */ }`
  - `catalogMakesSchema` = `{ items: Array<{ make: string; count: number }> }`, `catalogModelsSchema` = `{ items: Array<{ model: string; count: number }> }`
  - `subscriptionViewSchema` = `{ planCode: string; planName: string; status: string; endsAt: string|null; limits: PlanLimits; usage: { searchProfiles: number; notificationsToday: number } }`
  - `encodeCursor(v: object): string` / `decodeCursor<T>(s: string, schema: z.ZodType<T>): T | null` (base64url JSON; geçersizse null)

- [ ] **Step 1: Başarısız testleri yaz**

`packages/shared/src/panel.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  decodeCursor,
  encodeCursor,
  listingCardSchema,
  opportunitiesQuerySchema,
  putFavoriteSchema,
} from './index';

describe('panel contracts', () => {
  it('opportunities query defaults and bounds', () => {
    expect(opportunitiesQuerySchema.parse({})).toMatchObject({ sort: 'score', limit: 24 });
    expect(opportunitiesQuerySchema.safeParse({ minScore: '59' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ confidence: 'LOW' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ maxPrice: '1.5' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(opportunitiesQuerySchema.safeParse({ foo: '1' }).success).toBe(false);
  });
  it('cursor round-trips and rejects garbage', () => {
    const s = z.object({ score: z.number(), id: z.number() });
    const c = encodeCursor({ score: 77, id: 12 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, s)).toEqual({ score: 77, id: 12 });
    expect(decodeCursor('!!!', s)).toBeNull();
    expect(decodeCursor(encodeCursor({ score: 'x' }), s)).toBeNull();
  });
  it('favorite note is trimmed and bounded', () => {
    expect(putFavoriteSchema.parse({ note: '  güzel  ' })).toEqual({ note: 'güzel' });
    expect(putFavoriteSchema.safeParse({ note: 'x'.repeat(281) }).success).toBe(false);
    expect(putFavoriteSchema.parse({})).toEqual({});
  });
  it('listing card requires money strings', () => {
    const card = {
      id: 1, title: 't', make: 'BMW', model: '3', trim: null, year: 2019, km: 1, fuel: 'GASOLINE', transmission: 'AUTOMATIC',
      city: null, price: '960000', imageUrl: null, url: 'https://x', status: 'ACTIVE', firstSeenAt: '2026-10-10T00:00:00.000Z',
      analysis: null, isFavorite: false,
    };
    expect(listingCardSchema.parse(card)).toEqual(card);
    expect(listingCardSchema.safeParse({ ...card, price: 960000 }).success).toBe(false);
  });
});
```

Run: `pnpm --filter @oto/shared test` → FAIL.

- [ ] **Step 2: Uygula**

`packages/shared/src/schemas/panel.ts` → yukarıdaki şemaları yaz (`money = z.string().regex(/^-?\d+$/)`, `iso = z.string().datetime()`, sorgu şemalarında `z.coerce`). `encodeCursor`: `Buffer.from(JSON.stringify(v)).toString('base64url')`; `decodeCursor`: `try { schema.safeParse(JSON.parse(Buffer.from(s,'base64url').toString('utf8'))) }` → başarılıysa veri, değilse null; `s` `^[A-Za-z0-9_-]{1,512}$` değilse null. (Not: `Buffer` yalnızca sunucuda kullanılır; web bu iki fonksiyonu kullanmaz. Web paketini bozmamak için bu dosya `Buffer`'a yalnızca fonksiyon gövdesinde erişir.) `index.ts` → `export * from './schemas/panel';`.

- [ ] **Step 3: Test + build** → `pnpm --filter @oto/shared test && pnpm --filter @oto/shared build && pnpm typecheck`

- [ ] **Step 4: Commit** → `git add packages/shared && git commit -m "feat(shared): add panel response and query contracts with opaque cursors"`

---

### Task 2: API — katalog, fırsatlar, ilan detayı

**Files:**
- Create: `apps/api/src/modules/catalog/{catalog.module,catalog.controller,catalog.repository}.ts`, `apps/api/src/modules/me/{listing-card.view,opportunities.repository,opportunities.controller,listings.repository,listings.controller}.ts`, `apps/api/test/catalog.e2e.spec.ts`, `apps/api/test/panel.e2e.spec.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/modules/me/me.module.ts`, `apps/api/test/isolation.e2e.spec.ts`, `apps/api/test/helpers.ts` (`seedListing`'e `imageUrl`, `explanation` desteği zaten `over` ile var — gerekirse `seedPriceHistory` ekle)

**Interfaces:**
- Consumes: Task 1 şemaları; `LimitsService.forUser` (`opportunitiesDelayHours`); `RedisService`.
- Produces:
  - `toListingCard(listing, analysis | null, isFavorite: boolean): ListingCard` ve `toAnalysisSummary(analysis): AnalysisSummary` (`band` = `explanation.stats` q1/median/q3 → yuvarlanmış tam sayı dizgisi; `insufficientReason` `explanation.insufficientReason ?? 'NONE'`)
  - `GET /catalog/makes`, `GET /catalog/makes/:make/models` (kimlikli; Redis anahtarları `catalog:makes`, `catalog:models:<fold>`; TTL 600 sn; make param ≤ 40 karakter)
  - `GET /me/opportunities` → `{ items: ListingCard[], nextCursor: string|null }`
  - `GET /me/listings/:id` → `ListingDetail` (id 1..2147483647 değilse 404)

- [ ] **Step 1: Başarısız testler**

`apps/api/test/panel.e2e.spec.ts` (gerçek kodla yaz; `seedListing` ve `seedMatch` mevcut yardımcılar):

```ts
describe('GET /me/opportunities', () => {
  it('returns ACTIVE listings with score>=60 and confidence>=MEDIUM, best score first, as cards', async () => {
    // seed: A score 77 HIGH, B score 65 MEDIUM, C score 90 LOW (hariç), D score 50 HIGH (hariç), E REMOVED score 95 (hariç)
    // GET → [A, B] sırası; kart: price '960000', analysis.band.median dizgi, isFavorite false
  });
  it('filters (make case-insensitive via fold, city, maxPrice, minScore, confidence) and sorts recent/discount', async () => {});
  it('paginates with an opaque cursor without duplicates or gaps across equal scores', async () => {
    // 5 ilan aynı skor 70 → limit 2 ile 3 sayfa, id'ler benzersiz ve toplam 5; bozuk cursor → 400 VALIDATION_FAILED
  });
  it('respects opportunitiesDelayHours from the user plan', async () => {
    // limitOverrides { opportunitiesDelayHours: 2 } → firstSeenAt şimdi olan ilan görünmez, 3 saat önceki görünür
  });
  it('marks favorites', async () => {});
});

describe('GET /me/listings/:id', () => {
  it('returns detail with band, price history, comparables joined to listings, and my matches only', async () => {
    // analysis.explanation.comparables iki emsal id'si içerir (gerçek seed ilanları); stats q1/median/q3
    // A'nın bu ilanda bir eşleşmesi, B'nin bir eşleşmesi → A yalnızca kendininkini görür
  });
  it('REMOVED listing is still readable with status REMOVED; unknown/invalid id → 404', async () => {});
  it('listing without analysis returns analysis null and explanation null', async () => {});
});
```

`apps/api/test/catalog.e2e.spec.ts`: makes sayıya göre azalan (eşitlikte ada göre), REMOVED sayılmaz; models `fold_tr` ile büyük/küçük harf duyarsız make eşleşmesi (`/catalog/makes/bmw/models`); kimliksiz → 401; önbellek: ikinci çağrı yeni eklenen ilanı göstermez (Redis'e yazıldığını doğrula), `flushdb` sonrası gösterir.

İzolasyon `CASES`: `'GET /me/opportunities'` (B, A'nın favorisini `isFavorite:true` görmez), `'GET /me/listings/:id'` (B, A'nın `myMatches`'ini görmez; pozitif kontrol: A görür).

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/panel.e2e.spec.ts test/catalog.e2e.spec.ts test/isolation.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`opportunities.repository.ts` (ham SQL; tek sorgu, keyset sayfalama):

```ts
const SORTS = {
  score: { key: Prisma.sql`a."opportunityScore"`, dir: 'DESC' },
  recent: { key: Prisma.sql`l."firstSeenAt"`, dir: 'DESC' },
  discount: { key: Prisma.sql`a."discountPct"`, dir: 'DESC' },
} as const;
```
Sorgu: `FROM "Listing" l JOIN "ListingAnalysis" a ON a.id = l."latestAnalysisId" LEFT JOIN "Favorite" f ON f."listingId" = l.id AND f."userId" = $userId WHERE l.status='ACTIVE' AND a."opportunityScore" >= $minScore AND confidence_rank(a.confidence::text) >= confidence_rank($conf) AND l."firstSeenAt" <= $visibleBefore [AND fold_tr(l.make)=fold_tr($make)] [AND fold_tr(l.model)=fold_tr($model)] [AND fold_tr(l.city)=fold_tr($city)] [AND l.price <= $maxPrice] [AND (sortKey, l.id) < ($cursorKey, $cursorId)] ORDER BY sortKey DESC NULLS LAST, l.id DESC LIMIT $limit+1`. `discount` sıralamasında `discountPct` null olabilir → `COALESCE(a."discountPct", -1)` hem sıralamada hem cursor karşılaştırmasında kullanılır; `recent` cursor'ı ISO tarih. Cursor şeması sıralamaya göre `{ k: number | string, id: number }`; çözülemezse `Errors.validation(...)`. Kullanıcı `favorite` eşlemesi yalnızca kendi `userId`'si ile (repository, `me/**` lint kuralına uygun).

`listings.repository.ts`: `findDetail(userId, id)` → listing + latestAnalysis + priceHistory (observedAt artan, en fazla 200) + favorite (userId) + myMatches (userId, listingId, en yeni 20, profile adıyla) + emsaller: `explanation.comparables` id'leri (ilk 30, outlier olmayanlar önce) için `listing.findMany({ where: { id: { in } }, select: { id, title, city, url, status } })` ile birleştir; `adjusted` dizgiye yuvarlanır.

`catalog.repository.ts`: `SELECT make, count(*)::int FROM "Listing" WHERE status='ACTIVE' GROUP BY make ORDER BY count DESC, make ASC LIMIT 200`; modeller `WHERE status='ACTIVE' AND fold_tr(make)=fold_tr($make) GROUP BY model …`. Redis önbelleği controller/servis katmanında (catalog modülü `me/**` dışında, Prisma doğrudan kullanılabilir).

`listing-card.view.ts`: `toListingCard`, `toAnalysisSummary` (BigInt → dizgi, Decimal → number).

- [ ] **Step 3: Test** → `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts && pnpm lint && pnpm typecheck`

- [ ] **Step 4: Commit** → `git add apps/api && git commit -m "feat(api): add catalog, opportunities with keyset cursor and listing detail endpoints"`

---

### Task 3: API — favoriler, abonelik, dashboard

**Files:**
- Create: `apps/api/src/modules/me/{favorites.repository,favorites.controller,dashboard.repository,dashboard.controller,subscription.controller}.ts`, `apps/api/test/favorites.e2e.spec.ts`
- Modify: `apps/api/src/modules/me/me.module.ts`, `apps/api/test/panel.e2e.spec.ts`, `apps/api/test/isolation.e2e.spec.ts`

**Interfaces:**
- Consumes: `toListingCard` (Task 2), `LimitsService`, `MeRepository.countExternalNotificationsSince`, `startOfIstanbulDay`.
- Produces:
  - `GET /me/favorites` → `{ items: FavoriteItem[], nextCursor: number|null }` (cursor = Favorite id; en yeni önce)
  - `PUT /me/favorites/:listingId` `{note?}` → 200 `FavoriteItem` (idempotent upsert; olmayan ilan → 404)
  - `DELETE /me/favorites/:listingId` → 204 (yoksa 404)
  - `GET /me/subscription` → `SubscriptionView`
  - `GET /me/dashboard` → `Dashboard`

- [ ] **Step 1: Başarısız testler**

`favorites.e2e.spec.ts`: ekle → listede görünür (kart + note); tekrar PUT notu günceller (tek kayıt); olmayan ilan 404; DELETE 204 sonra 404; cursor sayfalama; `listingId` geçersiz → 404; REMOVED ilan favoride kalır ve `status: 'REMOVED'` görünür.

`panel.e2e.spec.ts` ekle: `GET /me/subscription` FREE/FALLBACK ve override limitleri; `GET /me/dashboard` → 3 eşleşme seed (biri 8 gün önce `createdAt` ile) → `recentMatches` yeni→eski en fazla 8; `series` tam 7 eleman, son eleman bugün (İstanbul `YYYY-MM-DD`), 8 gün önceki eşleşme seride yok; `profiles` {active,total,max}; `notifications` {today, limit}.

İzolasyon `CASES`: `'GET /me/favorites'`, `'PUT /me/favorites/:listingId'` (B'nin PUT'u A'nın listesini değiştirmez), `'DELETE /me/favorites/:listingId'` (B, A'nın favorisini silemez: B için 404, A'da duruyor), `'GET /me/subscription'`, `'GET /me/dashboard'` (B, A'nın eşleşmelerini görmez).

- [ ] **Step 2: Uygula**

`dashboard.repository.ts` seri sorgusu:

```sql
SELECT to_char(("createdAt" AT TIME ZONE 'Europe/Istanbul')::date, 'YYYY-MM-DD') AS day, count(*)::int AS matches
FROM "ListingMatch" WHERE "userId" = $1 AND "createdAt" >= $2
GROUP BY 1
```
`$2` = `startOfIstanbulDay(now) − 6 gün`; servis eksik günleri 0 ile doldurur (7 eleman). Profil sayıları `searchProfile.count`; `max` = `LimitsService.forUser(...).maxSearchProfiles`; bildirim sayısı `countExternalNotificationsSince` (`/me` ile aynı tanım).

`favorites.repository.ts` → `upsert` (`userId_listingId`), listing varlığı kontrolü (`listing.findUnique` id+select), liste `include: { listing: { include: { latestAnalysis: true } } }`.

- [ ] **Step 3: Test** → `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts && pnpm lint && pnpm typecheck && pnpm --filter @oto/api build`

- [ ] **Step 4: Commit** → `git add apps/api && git commit -m "feat(api): add favorites, subscription and dashboard endpoints"`

---

### Task 4: Web iskeleti — Next.js, tasarım token'ları, fontlar, tema, test altyapısı

**Files:**
- Create: `apps/web/{package.json,next.config.mjs,postcss.config.mjs,tsconfig.json,vitest.config.ts,vitest.setup.ts,next-env.d.ts,.gitignore}`, `apps/web/src/app/{layout.tsx,globals.css,page.tsx,not-found.tsx}`, `apps/web/src/lib/{cn.ts,theme.ts}`, `apps/web/src/components/theme-toggle.tsx`, `apps/web/src/components/ui/{button,input,label,select,switch,dialog,dropdown-menu,tabs,tooltip,badge,skeleton,card,sheet,separator}.tsx`, `apps/web/src/components/ui/ui.spec.tsx`
- Modify: `eslint.config.mjs` (tsx + react-hooks), kök `package.json` (`dev:web`), `.env.example` (`API_ORIGIN`), `pnpm-workspace.yaml` (gerekirse)

**Interfaces:**
- Produces:
  - `pnpm --filter @oto/web dev` (port 3000), `build`, `start`, `test`, `typecheck`, `lint` script'leri.
  - `next.config.mjs` → `rewrites: [{ source: '/api/:path*', destination: \`${process.env.API_ORIGIN ?? 'http://localhost:3001'}/api/:path*\` }]`, `transpilePackages: ['@oto/shared']`, `reactStrictMode: true`, `poweredByHeader: false`.
  - CSS token'ları (`globals.css`, Tailwind v4 `@theme`): `--color-bg #0E0F11`, `--color-surface #15171A`, `--color-surface-2 #1B1E22`, `--color-border #262A30`, `--color-text #ECEDEE`, `--color-muted #9AA0A6`, `--color-accent #E8A35C`, `--color-accent-fg #1A1207`, `--color-positive #4FB286`, `--color-danger #E5484D`, `--color-warning #E2B340`; açık tema `[data-theme=light]` karşılıkları (`--color-bg #F7F6F3`, `--color-surface #FFFFFF`, `--color-border #E4E2DD`, `--color-text #16181B`, `--color-muted #5F646B`, `--color-accent #B86A1E` (AA için koyulaştırılmış)); `--font-display`, `--font-sans`, `--font-mono`; odak halkası `outline: 2px solid var(--color-accent)`.
  - `layout.tsx`: `next/font/google` Instrument_Sans, Inter, Geist_Mono (`subsets: ['latin','latin-ext']`, `display: 'swap'`, CSS değişkenleri), `<html lang="tr" data-theme="dark" suppressHydrationWarning>`, FOUC önleyici satır içi tema script'i (`localStorage.theme` ya da `prefers-color-scheme`), `Providers` (Task 5'te).
  - `ThemeToggle` (sistem/koyu/açık), `cn()` (clsx + tailwind-merge).
  - UI primitifleri: Radix tabanlı, `cn` ile varyantlar (`class-variance-authority`); `Button` varyantları `primary` (amber), `secondary`, `ghost`, `danger`; boyutlar `sm|md|lg`; `asChild`.

- [ ] **Step 1: Uygulamayı oluştur (manuel dosyalar; `create-next-app` etkileşimli olduğu için kullanılmaz)**

`apps/web/package.json`:

```json
{
  "name": "@oto/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@oto/shared": "workspace:*",
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-dropdown-menu": "^2.1.4",
    "@radix-ui/react-label": "^2.1.1",
    "@radix-ui/react-select": "^2.1.4",
    "@radix-ui/react-separator": "^1.1.1",
    "@radix-ui/react-slot": "^1.1.1",
    "@radix-ui/react-switch": "^1.1.2",
    "@radix-ui/react-tabs": "^1.1.2",
    "@radix-ui/react-tooltip": "^1.1.6",
    "@hookform/resolvers": "^3.9.1",
    "@tanstack/react-query": "^5.62.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.468.0",
    "motion": "^11.15.0",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.54.0",
    "recharts": "^2.15.0",
    "sonner": "^1.7.1",
    "tailwind-merge": "^2.6.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "msw": "^2.7.0",
    "tailwindcss": "^4.0.0",
    "vitest": "^3.0.5"
  }
}
```
(Sürümler kurulum anında çözülür; `pnpm install` sonrası kilit dosyası commit'lenir. Bir paket bu sürüm aralığında yoksa en yakın kararlı sürümü kullan ve raporda belirt.)

`tsconfig.json` (web'e özel; kök `tsconfig.base.json`'u **genişletmez** — CommonJS ayarları Next ile uyumsuz):

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "ES2023"], "allowJs": false, "skipLibCheck": true, "strict": true,
    "noEmit": true, "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true,
    "isolatedModules": true, "jsx": "preserve", "incremental": true, "plugins": [{ "name": "next" }], "paths": { "@/*": ["./src/*"] },
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts", "middleware.ts"],
  "exclude": ["node_modules"]
}
```

`vitest.config.ts`: `@vitejs/plugin-react`, `environment: 'jsdom'`, `setupFiles: ['./vitest.setup.ts']`, `globals: true`, alias `@` → `src`, `include: ['src/**/*.spec.{ts,tsx}']`. `vitest.setup.ts`: `@testing-library/jest-dom/vitest`, `matchMedia` ve `ResizeObserver` stub'ları.

`eslint.config.mjs`: `**/*.tsx` dosyalarını TypeScript ayrıştırıcısıyla kapsa, `eslint-plugin-react-hooks` önerilen kuralları `apps/web/**` için etkinleştir (bağımlılığı kök devDependencies'e ekle); `.next/**` zaten yoksayılıyor.

- [ ] **Step 2: Başarısız test**

`src/components/ui/ui.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';
import { ThemeToggle } from '../theme-toggle';

describe('ui primitives', () => {
  it('primary button is focusable and fires onClick by keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Kaydet</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Kaydet' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });
  it('theme toggle switches data-theme and persists', async () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: /tema/i }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /açık/i }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
```

Run: `pnpm --filter @oto/web test` → FAIL; sonra bileşenleri yaz → PASS.

- [ ] **Step 3: Kök sayfa**

`src/app/page.tsx`: tanıtım sayfası (kısa, premium): başlık "Piyasanın altındaki ilanları ilk siz görün", alt başlık, fiyat bandı ön izleme görseli (Task 6 bileşeni hazır olunca kullanılır; şimdilik statik SVG şerit), "Ücretsiz başla" (→ `/kayit`) ve "Giriş yap" (→ `/giris`) butonları, yasal not "Fiyat analizi tahminidir; aracın durumunu garanti etmez." `not-found.tsx`: Türkçe 404.

- [ ] **Step 4: Doğrula** → `pnpm install && pnpm --filter @oto/web test && pnpm --filter @oto/web typecheck && pnpm --filter @oto/web build && pnpm lint`

- [ ] **Step 5: Commit** → `git add apps/web eslint.config.mjs package.json pnpm-lock.yaml .env.example && git commit -m "feat(web): scaffold Next.js app with Gece Showroom tokens, fonts, theme and UI primitives"`

---

### Task 5: Web — API istemcisi, oturum, kimlik sayfaları, middleware

**Files:**
- Create: `apps/web/src/lib/{api.ts,api.spec.ts,queries.ts,session.tsx}`, `apps/web/src/app/providers.tsx`, `apps/web/middleware.ts`, `apps/web/src/app/(auth)/{layout.tsx,giris/page.tsx,kayit/page.tsx,sifremi-unuttum/page.tsx,reset-password/page.tsx,verify-email/page.tsx}`, `apps/web/src/test/{server.ts,render.tsx}`, `apps/web/src/app/(auth)/auth.spec.tsx`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: `registerSchema`, `loginSchema`, `forgotPasswordSchema`, `resetPasswordSchema`, `verifyEmailSchema`, `resendVerificationSchema`, `ErrorCode` (`@oto/shared`).
- Produces:
  - `class ApiError extends Error { status: number; code: string; details?: unknown }`
  - `apiFetch<T>(path: string, init?: RequestInit & { json?: unknown; query?: Record<string, string|number|boolean|undefined> }): Promise<T>` — `/api/v1` öneki, `credentials: 'include'`, mutasyonlarda `X-Requested-With`, `json` → gövde; 204 → `undefined`; hata gövdesi `{error:{code,message,details}}` → `ApiError`; 401 akışı (karar tablosu: tek uçuşta refresh, bir kez yeniden deneme, başarısızsa `onSessionExpired()` → `/giris?next=<mevcut yol>`); `REFRESH_RACE` → 300 ms sonra bir kez.
  - `refreshSession(): Promise<boolean>` (paylaşılan promise)
  - `queryKeys` nesnesi ve hook'lar: `useMe()`, `useLogout()` (`POST /auth/logout`, query cache temizler, SSE'yi kapatır — Task 8 `closeNotificationStream()` çağrısı için `session.tsx`'te olay yayıcısı)
  - `<Providers>`: `QueryClientProvider` (`staleTime 30 sn`, `retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2`), `Toaster` (sonner, tema uyumlu), `TooltipProvider`.
  - `middleware.ts`: `matcher: ['/app/:path*']`; `access_token` veya `refresh_token` çerezi yoksa `/giris?next=<path>`'e 307. (Not: `refresh_token` çerezi `/api/v1/auth` yoluna kısıtlı olduğundan `/app` isteklerinde gelmez — middleware yalnızca `access_token`'a bakar; yoksa istemci tarafı refresh dener: middleware `access_token` yokken de geçirip sayfadaki `useMe` 401 → refresh akışına bırakmak yerine, **`/giris?next=…&try_refresh=1`'e yönlendirir; giriş sayfası `try_refresh=1` görürse önce `refreshSession()` dener, başarılıysa `next`'e döner**.)
  - Kimlik sayfaları (react-hook-form + zodResolver ile paylaşılan şemalar): giriş (e-posta, şifre; `LOGIN_LOCKED` ve `INVALID_CREDENTIALS` mesajları), kayıt (ad, e-posta, şifre ≥10, KVKK onayı zorunlu, `EMAIL_TAKEN`, `WEAK_PASSWORD`), şifremi unuttum (her zaman aynı başarı mesajı), şifre sıfırlama (`?token=`), e-posta doğrulama (`?token=` ile otomatik POST, sonuç durumu; doğrulama yeniden gönderme formu). Başarılı giriş/kayıt → `next` (yalnızca `/` ile başlayan iç yol; aksi halde `/app`).

- [ ] **Step 1: Başarısız testler**

`src/lib/api.spec.ts` (MSW `setupServer`):

```ts
describe('apiFetch', () => {
  it('sends credentials, X-Requested-With on mutations and JSON body', async () => {
    let seen: Request | undefined;
    server.use(http.post('/api/v1/me/search-profiles', ({ request }) => { seen = request; return HttpResponse.json({ id: 'p1' }, { status: 201 }); }));
    await apiFetch('/me/search-profiles', { method: 'POST', json: { name: 'x' } });
    expect(seen?.headers.get('x-requested-with')).toBe('XMLHttpRequest');
    expect(await seen?.json()).toEqual({ name: 'x' });
  });
  it('maps error bodies to ApiError', async () => {
    server.use(http.get('/api/v1/me', () => HttpResponse.json({ error: { code: 'LIMIT_REACHED', message: 'Sınır', details: { limit: 2 } } }, { status: 403 })));
    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 403, code: 'LIMIT_REACHED', details: { limit: 2 } });
  });
  it('on 401 refreshes once (single flight) and retries', async () => {
    let refreshes = 0; let calls = 0;
    server.use(
      http.get('/api/v1/me', () => (++calls === 1 ? HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: '' } }, { status: 401 }) : HttpResponse.json({ ok: true }))),
      http.get('/api/v1/me/dashboard', () => (calls < 2 ? HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: '' } }, { status: 401 }) : HttpResponse.json({ ok: 2 }))),
      http.post('/api/v1/auth/refresh', () => { refreshes += 1; return new HttpResponse(null, { status: 204 }); }),
    );
    await Promise.all([apiFetch('/me'), apiFetch('/me/dashboard')]);
    expect(refreshes).toBe(1);
  });
  it('redirects to login with next when refresh fails, without looping', async () => {
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    server.use(
      http.get('/api/v1/me', () => HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: '' } }, { status: 401 })),
      http.post('/api/v1/auth/refresh', () => HttpResponse.json({ error: { code: 'TOKEN_INVALID', message: '' } }, { status: 401 })),
    );
    await expect(apiFetch('/me')).rejects.toBeInstanceOf(ApiError);
    expect(onExpired).toHaveBeenCalledOnce();
  });
});
```
(`setSessionExpiredHandler(fn)` dışa aktarılır; varsayılan işleyici `window.location.assign('/giris?next=…')`.)

`(auth)/auth.spec.tsx`: giriş formu boş gönderimde alan hataları; `INVALID_CREDENTIALS` yanıtında "E-posta veya şifre hatalı"; başarılı girişte `next=/app/firsatlar` ise oraya yönlenir, `next=https://kotu.com` ise `/app`'e; kayıtta KVKK işaretsizse gönderilmez; şifremi unuttum her durumda aynı mesaj.

Run → FAIL.

- [ ] **Step 2: Uygula** (yukarıdaki arayüzler; kimlik sayfaları ortalanmış dar kart, sol kenarda ince amber çizgi, başlık Instrument Sans; her sayfada "Fiyat analizi tahminidir…" yasal notu yok — yalnızca ilan/fırsat ekranlarında.)

- [ ] **Step 3: Doğrula** → `pnpm --filter @oto/web test && pnpm --filter @oto/web typecheck && pnpm --filter @oto/web build && pnpm lint`

- [ ] **Step 4: Commit** → `git add apps/web && git commit -m "feat(web): add typed API client with single-flight refresh, auth pages and route guard"`

---

### Task 6: Web — imza bileşenleri (fiyat bandı, skor halkası, güven göstergesi, ilan kartı/tablo)

**Files:**
- Create: `apps/web/src/lib/{format.ts,format.spec.ts}`, `apps/web/src/components/{price-band.tsx,score-ring.tsx,confidence-meter.tsx,listing-card.tsx,listing-table.tsx,favorite-button.tsx,signature.spec.tsx}`

**Interfaces:**
- Consumes: `ListingCard`, `AnalysisSummary` (Task 1).
- Produces:
  - `formatTl(v: string|bigint|number): string` → `"960.000 ₺"`; `formatKm(n)` → `"85.000 km"`; `formatDiscount(p: number|null)` → `"%20 altında"` / `"%5 üstünde"` / `null`; `formatRelative(iso, now?)` → `"12 dk önce"`, `"3 sa önce"`, `"2 gün önce"`; `formatDateTime(iso)` İstanbul `"10.10.2026 14:32"`; `CONFIDENCE_LABEL`, `FUEL_LABEL`, `GEAR_LABEL` sözlükleri.
  - `bandGeometry({ q1, median, q3, price }: { q1: number|null; median: number|null; q3: number|null; price: number }): { min: number; max: number; pos: (v:number)=>number /*0..100 yüzde*/; markerClamped: boolean } | null`
  - `<PriceBand band price confidence insufficientReason size="sm|lg" />` — SVG/flex şerit; Q1–Q3 dolu bölge, medyan çizgisi ve etiketi ("medyan 1,2 Mn ₺" kısa biçim), ilan fiyatı ▲ işaretçisi ("bu ilan"); `role="img"` ve `aria-label="Fiyat bandı: ilan 960.000 ₺, medyan 1.200.000 ₺, alt çeyrek …"`; null ise "Zayıf tahmin — {sebep}" metni (`NO_LEVEL`: "yeterli benzer ilan yok", `AFTER_OUTLIERS`: "uç değerler ayıklandıktan sonra emsal yetersiz", `INVALID_TARGET`: "ilan fiyatı geçersiz").
  - `<ScoreRing score={77} />` — SVG halka, 0–100, ≥60 amber, diğerleri muted; ortada Geist Mono sayı; `aria-label="Fırsat skoru 77/100"`.
  - `<ConfidenceMeter confidence="HIGH" comparableCount={14} />` — 4 segment (HIGH 4, MEDIUM 3, LOW 2, INSUFFICIENT 1 dolu) + metin "Yüksek güven · 14 emsal".
  - `<ListingCardView card={ListingCard} highlight?: boolean onToggleFavorite? />` — spec §8 ASCII düzeni; `highlight` iken tek seferlik amber parıltı (motion; reduced-motion'da yok); dış bağlantı `↗` (`rel="noopener noreferrer nofollow"`, `target="_blank"`), kart tıklaması `/app/ilan/:id`; REMOVED rozeti; `limitExceeded` ile ilgisi yok.
  - `<ListingTable rows={ListingCard[]} />` — masaüstü tablo; `md` altı otomatik olarak kart listesine döner.
  - `<FavoriteButton listingId isFavorite />` — optimistic `PUT/DELETE /me/favorites/:id`, hata olursa geri alır ve toast.

- [ ] **Step 1: Başarısız testler**

`format.spec.ts`:

```ts
describe('format', () => {
  it('money, km, discount', () => {
    expect(formatTl('960000')).toBe('960.000 ₺');
    expect(formatKm(85000)).toBe('85.000 km');
    expect(formatDiscount(0.2)).toBe('%20 altında');
    expect(formatDiscount(-0.05)).toBe('%5 üstünde');
    expect(formatDiscount(null)).toBeNull();
  });
  it('relative and Istanbul date time', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(formatRelative('2026-10-10T11:48:00Z', now)).toBe('12 dk önce');
    expect(formatRelative('2026-10-10T09:00:00Z', now)).toBe('3 sa önce');
    expect(formatRelative('2026-10-08T12:00:00Z', now)).toBe('2 gün önce');
    expect(formatDateTime('2026-10-10T11:32:00Z')).toBe('10.10.2026 14:32');
  });
  it('band geometry clamps the marker and handles missing stats', () => {
    const g = bandGeometry({ q1: 1_000_000, median: 1_200_000, q3: 1_400_000, price: 960_000 })!;
    expect(g.pos(1_200_000)).toBeGreaterThan(g.pos(1_000_000));
    expect(g.pos(960_000)).toBeGreaterThanOrEqual(0);
    expect(g.markerClamped).toBe(false);
    const far = bandGeometry({ q1: 1_000_000, median: 1_200_000, q3: 1_400_000, price: 50_000 })!;
    expect(far.pos(50_000)).toBeGreaterThanOrEqual(0);
    expect(bandGeometry({ q1: null, median: null, q3: null, price: 1 })).toBeNull();
  });
});
```
(`markerClamped` = fiyat eksen sınırlarının dışında kalıp sınıra çekildiyse true; eksen [min(Q1,fiyat)×0,9, max(Q3,fiyat)×1,1] olduğundan normalde false — aşırı değerlerde eksen 0,5×Q1'in altına inmez ve işaretçi kırpılır: kural `min = max(min(Q1,fiyat)×0,9, Q1×0,5)`; `far` örneğinde `markerClamped === true` beklenir, testi buna göre genişlet.)

`signature.spec.tsx`: PriceBand erişilebilir etiketi fiyat/medyanı içerir; INSUFFICIENT kart "Zayıf tahmin — yeterli benzer ilan yok" gösterir; ScoreRing etiketi; ConfidenceMeter 4 segmentten 3'ü dolu ve "Orta güven · 6 emsal"; ListingCard: başlık satırı "BMW 3 Serisi 320i · 2019", fiyat, "%20 altında", dış bağlantı `rel` değeri, REMOVED rozeti; FavoriteButton optimistic geçiş ve hata geri alımı (MSW).

- [ ] **Step 2: Uygula** — görsel ayrıntılar `frontend-design` skill'i ile; spec §8 ASCII düzenine sadık kal.

- [ ] **Step 3: Doğrula** → `pnpm --filter @oto/web test && pnpm --filter @oto/web typecheck && pnpm lint`

- [ ] **Step 4: Commit** → `git add apps/web && git commit -m "feat(web): add price band, score ring, confidence meter and listing card components"`

---

### Task 7: Web — uygulama kabuğu ve dashboard

**Files:**
- Create: `apps/web/src/components/{app-shell.tsx,user-menu.tsx,verify-banner.tsx,empty-state.tsx}`, `apps/web/src/app/app/{layout.tsx,page.tsx}`, `apps/web/src/app/app/dashboard.spec.tsx`

**Interfaces:**
- Consumes: `useMe`, `useLogout`, `Dashboard` (`GET /me/dashboard`), `ListingCardView`.
- Produces:
  - `AppShell`: masaüstünde sol sidebar (Dashboard, Fırsatlar, Arama Profillerim, Eşleşmeler, Favoriler, Bildirimler, Abonelik, Ayarlar; aktif öğe amber sol çizgi), üst çubuk (sayfa başlığı, `NotificationBell` yeri — Task 8, tema düğmesi, kullanıcı menüsü: ad/e-posta, Ayarlar, Çıkış); ≤ 768 px'te sidebar `Sheet` drawer (hamburger, Esc ile kapanır, odak tuzağı).
  - `VerifyBanner`: `emailVerifiedAt` null ise "E-postanızı doğrulayın — doğrulanmamış hesaplar 1 profil oluşturabilir ve Telegram bağlayamaz" + "Bağlantıyı yeniden gönder" (`POST /auth/resend-verification`).
  - Dashboard: üstte 4 metrik kutusu (Aktif profil x/max, Bugünkü bildirim x/limit, 7 günlük eşleşme toplamı, Plan adı) — sayılar Geist Mono; 7 günlük eşleşme seri grafiği (Recharts küçük bar, amber); "Son eşleşmeler" kart ızgarası (en fazla 8); boş durumlar: profil yoksa "İlk arama profilinizi oluşturun" CTA; eşleşme yoksa açıklama ("Yeni profiller, oluşturulduktan sonra analiz edilen ilanlarla eşleşir. Mevcut fırsatlar için Fırsatlar sayfasına bakın.").

- [ ] **Step 1: Başarısız testler** — `dashboard.spec.tsx` (MSW): metrikler doğru metinle görünür; boş profil CTA'sı; doğrulanmamış kullanıcıda banner ve yeniden gönder çağrısı; mobil genişlikte (`window.innerWidth=375` + `matchMedia`) hamburger ile drawer açılır ve Esc ile kapanır; çıkış `POST /auth/logout` sonrası `/giris`'e yönlendirir.
- [ ] **Step 2: Uygula**
- [ ] **Step 3: Doğrula** → web test + typecheck + build + lint
- [ ] **Step 4: Commit** → `feat(web): add app shell with responsive navigation and dashboard`

---

### Task 8: Web — canlı bildirimler (zil, toast, akış) ve bildirimler sayfası

**Files:**
- Create: `apps/web/src/lib/{sse.ts,sse.spec.ts}`, `apps/web/src/components/notification-bell.tsx`, `apps/web/src/components/notification-item.tsx`, `apps/web/src/app/app/bildirimler/page.tsx`, `apps/web/src/app/app/bildirimler/notifications.spec.tsx`
- Modify: `apps/web/src/components/app-shell.tsx`, `apps/web/src/lib/session.tsx`

**Interfaces:**
- Consumes: SSE `/api/v1/me/notifications/stream` (`ready {unreadCount,lastId}`, `notification`, `ping`), `GET /me/notifications`, `POST /me/notifications/read`, `MatchNotificationPayload`, `SecurityNotificationPayload`.
- Produces:
  - `createNotificationStream(opts: { onReady(r: { unreadCount: number; lastId: number|null }): void; onNotification(n: UserEvent['notification']): void; onStatus?(s: 'connecting'|'open'|'closed'): void; eventSourceFactory?: (url: string) => EventSource; refresh?: () => Promise<boolean>; now?: () => number }): { close(): void }` — `withCredentials: true`; `error`/kapanma → üstel bekleme 1, 2, 4 … 30 sn (+ ±20% jitter), her yeniden bağlanmadan önce `refresh()`; 14 dk 30 sn'de proaktif yeniden bağlanma (sunucu 15 dk'da kapatır); `close()` zamanlayıcıları temizler.
  - `useNotificationStream()` hook: React Query cache'ini günceller (`['notifications','unread']` = sayaç; her `ready`'de `['notifications','list']` geçersiz kılınır); `id <= lastId` olayları sayaç için yok sayılır, aynı id iki kez gelirse tek sayılır; toast hız sınırı (5 sn'de 3, fazlası tek "+N yeni eşleşme"); `SECURITY` olayları için metin: `TELEGRAM_LINKED` "Telegram hesabınız bağlandı", `TELEGRAM_UNLINKED` "Telegram sohbetiniz başka bir hesaba bağlandı", `TELEGRAM_DISABLED` "Telegram bildirimleri durduruldu (bot engellendi veya sohbet bulunamadı)", `REFRESH_REUSED` "Güvenlik: oturumunuz başka bir yerden kullanıldığı için sonlandırıldı".
  - `closeNotificationStream()` — çıkışta `session.tsx` tarafından çağrılır.
  - `NotificationBell`: sayaç rozeti (99+), sayarak artan animasyon (reduced-motion'da anlık), açılır panel: son 10 bildirim, "Tümünü okundu yap", "Tümünü gör".
  - Bildirimler sayfası: filtreler (okunmamış, kanal, durum), sonsuz kaydırma (cursor), her öğe: MATCH için mini kart (başlık, fiyat, neden rozeti "Yeni"/"Fiyat düştü 1.010.000 → 960.000 ₺"/"Yeniden yayında"), `limitExceeded` için "Limit aşıldı" rozeti ve açıklama tooltip'i, kanal + durum ("Telegram · gönderildi", "Telegram · başarısız: …", "Telegram · limit"), okunmamış nokta; tıklama okundu işaretler ve ilana gider.

- [ ] **Step 1: Başarısız testler**

`sse.spec.ts` (sahte `EventSource` sınıfı ile; zamanlayıcılar `vi.useFakeTimers()`):

```ts
it('ready sets count and lastId; older or duplicate events are not double counted', () => { /* ready {3, lastId 10}; notification id 9 → sayılmaz; id 11 → 4; id 11 tekrar → 4 */ });
it('reconnects with exponential backoff after error and refreshes before reconnecting', async () => { /* error → 1 sn sonra refresh + yeni EventSource; ikinci error → 2 sn */ });
it('proactively reconnects before the 15 minute server cutoff', () => { /* 14 dk 30 sn sonra yeni bağlantı */ });
it('close() stops reconnecting', () => {});
```

`notifications.spec.tsx`: liste + "Limit aşıldı" rozeti + SECURITY metni; okunmamış filtresi; "Tümünü okundu yap" `POST /me/notifications/read {all:true}` ve sayaç 0; zil: ready sonrası rozet sayısı, yeni olayda artış ve toast; 10 olay arka arkaya → en fazla 3 toast + "+7 yeni eşleşme".

- [ ] **Step 2: Uygula**
- [ ] **Step 3: Doğrula** → web test + typecheck + build + lint
- [ ] **Step 4: Commit** → `feat(web): add live notification stream, bell with rate-limited toasts and notifications page`

---

### Task 9: Web — fırsatlar, ilan detayı, favoriler, eşleşmeler

**Files:**
- Create: `apps/web/src/app/app/firsatlar/{page.tsx,opportunities.spec.tsx}`, `apps/web/src/app/app/ilan/[id]/{page.tsx,listing.spec.tsx}`, `apps/web/src/app/ilan/[id]/page.tsx` (yönlendirme), `apps/web/src/components/{price-history-chart.tsx,explanation-panel.tsx,filters-bar.tsx}`, `apps/web/src/app/app/favoriler/page.tsx`, `apps/web/src/app/app/eslesmeler/page.tsx`

**Interfaces:**
- Consumes: `GET /me/opportunities`, `GET /catalog/makes(+models)`, `GET /me/listings/:id`, `GET/PUT/DELETE /me/favorites`, `GET /me/matches`, Task 6 bileşenleri.
- Produces:
  - Fırsatlar: filtre çubuğu (marka → model bağımlı select'ler katalogdan, şehir, en yüksek fiyat, min skor 60–100 kaydırıcı, güven Orta/Yüksek, sıralama Skor/En yeni/İndirim), filtreler URL `searchParams`'ta (paylaşılabilir), kart/tablo görünümü anahtarı (`localStorage`), sonsuz kaydırma (IntersectionObserver + "Daha fazla yükle" klavye alternatifi), iskelet yükleme, boş durum; yasal not.
  - İlan detayı (`/app/ilan/[id]`): başlık + rozetler (REMOVED "Yayından kalktı", hasar, şüpheli düşük), görsel (yoksa marka baş harfli yer tutucu), büyük fiyat + indirim + ScoreRing + ConfidenceMeter, PriceBand (lg), özellik tablosu (km, yakıt, vites, kasa, renk, şehir, satıcı tipi, ilk görülme/son görülme), hasar bilgisi (tramer TL, boyalı/değişen parçalar), fiyat geçmişi grafiği (Recharts adım çizgisi, Geist Mono eksen), "Fiyat nasıl hesaplandı?" paneli (`ExplanationPanel`: seviye ve kapsam açıklaması "±1 yıl, ±%25 km", kullanılan emsal sayısı, uç değer sayısı, km yöntemi (Theil–Sen/varsayılan), güven adımları listesi, emsal tablosu: başlık bağlantısı, yıl, km, ilan fiyatı, düzeltilmiş fiyat, rozetler (uç değer, sınırlandı, hasarlı); hasarlı dışlanan sayısı `comparables` ve `pool`'dan türetilir — `pool.damagedExcluded` doğrudan gösterilmez), "Eşleşmelerim" listesi, favori butonu, "İlana git ↗"; yasal not. Bulunamazsa 404 bileşeni.
  - `/ilan/[id]` → `redirect('/app/ilan/' + id)` (sayısal değilse 404).
  - Favoriler: kart ızgarası + not düzenleme (satır içi, 280 karakter sayaçlı), kaldırma (geri al toast'u).
  - Eşleşmeler: `/me/matches` liste (profil, neden, güven, min skor filtreleri; cursor), her satır mini kart + neden rozeti.

- [ ] **Step 1: Başarısız testler**

`opportunities.spec.tsx`: filtre değişince URL güncellenir ve istek parametreleri doğru gider (MSW istek yakalama); marka seçilince model listesi o markadan yüklenir; cursor ile ikinci sayfa eklenir ve aynı id iki kez görünmez; boş sonuçta boş durum; tablo/kart geçişi kalıcı.

`listing.spec.tsx`: detay alanları ve fiyat bandı; INSUFFICIENT analizde "Zayıf tahmin" ve açıklama panelinde sebep; REMOVED rozeti; açıklama panelinde emsal tablosu satır sayısı ve "uç değer" rozeti; hasarlı dışlanan sayısı türetilmiş değerle gösterilir; 404 yanıtında bulunamadı görünümü; favori geçişi.

- [ ] **Step 2: Uygula**
- [ ] **Step 3: Doğrula** → web test + typecheck + build + lint
- [ ] **Step 4: Commit** → `feat(web): add opportunities, listing detail with explanation panel, favorites and matches pages`

---

### Task 10: Web — arama profilleri (liste + canlı önizlemeli sihirbaz)

**Files:**
- Create: `apps/web/src/app/app/profiller/{page.tsx,yeni/page.tsx,[id]/page.tsx,profiles.spec.tsx}`, `apps/web/src/components/{profile-wizard.tsx,profile-preview.tsx}`

**Interfaces:**
- Consumes: `/me/search-profiles` CRUD + pause/resume + preview, `/catalog/*`, `createSearchProfileSchema`, `withProfileDefaults`, `/me` (limitler, doğrulama durumu), `/me/channels` (Telegram bağlı mı).
- Produces:
  - Liste: profil kartları (ad, özet filtre çipleri, durum anahtarı ACTIVE/PAUSED, kanallar, "Eşleşmeleri gör" → `/app/eslesmeler?profileId=`), kullanım "2/2 profil" ve limit dolu iken "Yeni profil" düğmesi devre dışı + açıklama (doğrulanmamışsa e-posta doğrulama, değilse plan yükseltme bağlantısı `/app/abonelik`); sil (onay dialog'u).
  - Sihirbaz (`/app/profiller/yeni` ve düzenleme `/app/profiller/[id]`): 3 adım — (1) Araç: marka/model (katalog), yıl aralığı, km üst sınırı, yakıt/vites çoklu seçim, şehirler (etiket girişi); (2) Fırsat ölçütü: "Yalnızca fırsatlar" (minDiscountPct kaydırıcı %5–%50, min güven Düşük/Orta/Yüksek) ↔ "Tüm yeni ilanlar" (minDiscountPct 0; güven alanı gizli + açıklama), fiyat aralığı, hasarlı hariç, fiyat düşüşü bildirimi (eşik %), yeniden yayın bildirimi; (3) Kanallar: Uygulama içi (her zaman, kilitli açık), Telegram (bağlı değilse "Ayarlar'dan bağlayın" bağlantısı; plan içermiyorsa devre dışı + açıklama), ad. Sağda (mobilde altta) canlı önizleme: 400 ms debounce ile `POST /me/search-profiles/preview`, "Son 20 eşleşecek ilan" mini kartları + "Tahmini günde ~X eşleşme" + "Yeni profiller yalnızca bundan sonra analiz edilen ilanlar için bildirim gönderir" notu.
  - Hata eşleme: `VALIDATION_FAILED` details → alan hataları; `LIMIT_REACHED` (`reason: 'EMAIL_NOT_VERIFIED' | 'PLAN'`, `channel`) → form üstü uyarı + yönlendirme; form verisi korunur.

- [ ] **Step 1: Başarısız testler** — `profiles.spec.tsx`: "Tüm yeni ilanlar" seçilince min güven alanı DOM'da yok ve gönderilen gövdede `minDiscountPct: 0`; önizleme debounce (hızlı 3 değişiklik → 1 istek); `LIMIT_REACHED` EMAIL_NOT_VERIFIED mesajı ve form değerleri korunur; Telegram planda yokken seçenek devre dışı; düzenlemede PATCH yalnızca değişen alanları gönderir; duraklat/sürdür anahtarı ve `LIMIT_REACHED` (sürdürme) mesajı; silme onayı.
- [ ] **Step 2: Uygula**
- [ ] **Step 3: Doğrula** → web test + typecheck + build + lint
- [ ] **Step 4: Commit** → `feat(web): add search profiles list and live-preview wizard`

---

### Task 11: Web — abonelik ve ayarlar (hesap, güvenlik, oturumlar, kanallar/Telegram)

**Files:**
- Create: `apps/web/src/app/app/abonelik/page.tsx`, `apps/web/src/app/app/ayarlar/{layout.tsx,page.tsx,guvenlik/page.tsx,kanallar/page.tsx,settings.spec.tsx}`

**Interfaces:**
- Consumes: `GET /me/subscription`, `PATCH /me`, `POST /me/change-password`, `GET/DELETE /me/sessions(/:id)`, `DELETE /me`, `GET /me/channels`, `POST /me/channels/telegram/link`, `PATCH /me/channels/:type`, `DELETE /me/channels/telegram`.
- Produces:
  - Abonelik: mevcut plan kartı (ad, durum; `FALLBACK` → "Ücretsiz plan"), limitler ve kullanım çubukları (profil, günlük bildirim), kanallar; plan karşılaştırma tablosu (FREE/PRO/BUSINESS seed limitleriyle, fiyatlar "yakında" — ödeme entegrasyonu kapsam dışı; "Yükselt" düğmesi devre dışı + "Ödeme yakında" tooltip'i).
  - Ayarlar → Hesap: ad güncelleme; e-posta (salt okunur) + doğrulama durumu; hesap silme (şifre onaylı dialog, KVKK açıklaması; 429 `RATE_LIMITED` mesajı).
  - Ayarlar → Güvenlik: şifre değiştirme (mevcut + yeni ≥10; 400/429 mesajları; başarıda diğer oturumların kapandığı bilgisi), oturumlar listesi (cihaz/UA kısaltılmış, IP maskeli, son kullanım, "Bu cihaz" etiketi, diğerlerini kapat).
  - Ayarlar → Bildirim kanalları: Uygulama içi (her zaman açık); Telegram kartı durumları: `telegramAvailable=false` → "Telegram bildirimleri şu anda kullanılamıyor"; doğrulanmamış hesap → doğrulama gereksinimi; bağlı değil → "Telegram'ı bağla" → `deepLink` butonu (yeni sekme) + QR yok (MVP) + 10:00 geri sayım + "Bağlantı bekleniyor…" (5 sn'de bir `/me/channels` yoklaması ya da SSE `TELEGRAM_LINKED`) → başarıda "Bağlandı" toast; süre dolarsa "Yeni bağlantı oluştur"; bağlı → etkin/pasif anahtarı (`PATCH`), "Bağlantıyı kaldır" (onay); plan Telegram içermiyorsa açıklama.

- [ ] **Step 1: Başarısız testler** — `settings.spec.tsx`: Telegram üç durum + bağlama akışında geri sayım (fake timers) ve yoklama ile "Bağlandı"; `EMAIL_NOT_VERIFIED` ve `FEATURE_DISABLED` mesajları; şifre değiştirme hata eşleme ve başarı; oturum kapatma çağrısı; hesap silme dialog'u şifre olmadan gönderilmez; abonelik FALLBACK metni.
- [ ] **Step 2: Uygula**
- [ ] **Step 3: Doğrula** → web test + typecheck + build + lint
- [ ] **Step 4: Commit** → `feat(web): add subscription and settings pages with sessions and Telegram linking`

---

### Task 12: Dokümantasyon, yol haritası, görsel smoke

**Files:**
- Create: `docs/web.md`, `apps/web/scripts/screenshots.mjs`
- Modify: `README.md`, `docs/architecture.md`, `docs/superpowers/plans/2026-10-10-00-roadmap.md`, `.env.example`

- [ ] **Step 1: Dokümantasyon** — `docs/web.md` (Türkçe): çalışma (`pnpm dev:api` + `pnpm dev:web`, `API_ORIGIN`, `PUBLIC_BASE_URL=http://localhost:3000` API env'inde), rota haritası, veri çekme/refresh modeli, SSE sözleşmesi ve istemci kuralları, tasarım token'ları ve bileşenler, erişilebilirlik kuralları, test komutları. README'ye web bölümü ve `dev:web`; architecture.md'ye web katmanı. Yol haritasına `## Plan 06 sonrası taşınan maddeler`: Plan 07 (admin paneli aynı tasarım sistemiyle, `/admin` rotaları), Plan 08 (Playwright E2E senaryosu spec §10, Caddy ile tek origin, web Dockerfile, CSP nonce), ödeme entegrasyonu (abonelik yükselt), bildirim gruplama/özet, ses tercihi. Plan 03/04/05 sonrası Plan 06 maddelerini "TAMAMLANDI" işaretle.
- [ ] **Step 2: Tam doğrulama** → `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`
- [ ] **Step 3: Görsel smoke** — dev stack + api + worker + scheduler + demo-site (DEMO_SIZE=2000) + web; `screenshots.mjs` (Playwright, `@playwright/test` web devDependency'si; Chromium `pnpm --filter @oto/web exec playwright install chromium`) bir kullanıcı kaydeder (API), e-postayı DB'den doğrular, profil oluşturur, giriş çerezini kullanarak şu sayfaların 1440×900 koyu, 1440×900 açık ve 390×844 koyu ekran görüntülerini `apps/web/.screenshots/` (gitignore) altına alır: `/`, `/giris`, `/app`, `/app/firsatlar`, `/app/ilan/<bir fırsat id>`, `/app/profiller/yeni`, `/app/bildirimler`, `/app/ayarlar/kanallar`. Konsol hatalarını ve 4xx/5xx ağ yanıtlarını rapora yaz. Başlatılan tüm süreçleri durdur.
- [ ] **Step 4: Commit** → `git add docs README.md .env.example apps/web/scripts apps/web/package.json pnpm-lock.yaml && git commit -m "docs: document web app; add screenshot smoke script"`
