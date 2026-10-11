# Mimari (Plan 06 sonrası durum)

Ayrıntılı tasarım: `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`.

## Paketler
- `packages/shared` — zod şemaları (API sözleşmesi), hata kodları, plan limit tipi, zaman yardımcıları. Frontend de aynı şemaları kullanır.
- `packages/db` — Prisma şeması (tüm platform modelleri), migration'lar, seed (`FREE/PRO/BUSINESS` planları, ilk süper admin).
- `apps/api` — NestJS 11 REST API, `/api/v1`.
- `apps/web` — Next.js 15 kullanıcı paneli (bkz. aşağıda Web katmanı).

## İstek yaşam döngüsü (apps/api)
1. `helmet` → `cookie-parser` → JSON gövde (100 kb, hatalar standart formatta) → pino-http (`x-request-id`).
2. Global guard sırası: **CsrfGuard** (mutasyonlarda `X-Requested-With` + Origin) → **JwtAuthGuard** (`access_token` cookie; `@Public()` yoksa zorunlu) → **RolesGuard** (`@Roles` varsa oturum/kullanıcı/rol DB'den canlı) → **AppThrottlerGuard** (Redis; 120/dk, `/auth` 10/dk).
3. Handler → (`@Audited` ise) **AuditInterceptor** `AuditLog` yazar → **AllExceptionsFilter** tüm hataları `{ error: { code, message, details? } }` biçimine çevirir.

## Kimlik doğrulama
- Access: EdDSA JWT, 15 dk. Refresh: opak token, 30 gün, DB'de SHA-256; her kullanımda döner. Eski token 10 sn içinde gelirse `REFRESH_RACE` (aile korunur), sonra gelirse `REFRESH_REUSED` (aile iptal + güvenlik bildirimi + audit).
- Giriş kilidi: IP+e-posta başına 15 dk'da 5 hata (Redis).
- Askıya alma ve şifre sıfırlama tüm oturumları iptal eder; şifre değişimi (`/me/change-password`) geçerli oturum hariç DİĞER tüm oturumları iptal eder (mevcut oturum korunur). Şifre değişimi/sıfırlama, kullanılmamış diğer sıfırlama token'larını da geçersiz kılar. Admin uç noktaları ayrıca DB'den canlı doğrular.

## İzolasyon
- `/me` altındaki veri erişimi yalnızca `*.repository.ts` üzerinden ve `userId` ile yapılır (ESLint kuralı).
- `test/isolation.e2e.spec.ts`: her `/me` route'u için A/B senaryosu; eksik senaryo testi düşürür.
- `test/audit-coverage.e2e.spec.ts`: her `/admin` route'u rol ister, her admin mutasyonu `@Audited`'dır.

## Toplama hattı (Plan 02)
- **Paketler:** `@oto/collection` (framework'süz: normalizer, `PoliteHttpClient`, adapter'lar), `apps/demo-site` (geliştirme/test için sahte ilan sitesi), `apps/worker` (NestJS app context).
- **Süreçler:** `ROLE=scheduler` (tek instance) her `SCHEDULER_TICK_MS`'de zamanı gelen kaynak için `CollectionJob(QUEUED)` + `scrape` kuyruğu işi üretir, 30 dk'dan eski işleri kapatır, günlük 30 gün saklama temizliği yapar. `ROLE=worker` `scrape` işlerini `SCRAPE_CONCURRENCY` paralellikle yürütür; yatay ölçeklenir.
- **Tarama:** adapter sayfaları `PoliteHttpClient` ile çeker (robots, Redis'te paylaşılan hız limiti, 3 deneme, Retry-After, engel tespiti) → `normalizeListing` → `IngestService` (mükerrersiz upsert, fiyat/km geçmişi, REMOVED/RELISTED) → değişen ilanlar için `analyze` kuyruğu (tüketicisi Plan 03).
- **Güvenlik ağı:** tam ve sağlıklı (hata ≤ %20) taramalar dışında hiçbir ilan REMOVED yapılmaz; engellenen kaynak PAUSED olur ve yeniden denenmez.
- **Sağlık:** 3 ardışık hata DEGRADED, 6 DOWN; alarmlar `SystemLog` + adminlere panel bildirimi (anahtar başına 30 dk susturma). Worker'lar `worker:heartbeat:*` Redis anahtarlarıyla canlılık bildirir.

## Analiz (Plan 03)
- `@oto/analysis` (saf `rules-v1` motoru) + worker `AnalysisModule`. `analyze` kuyruğunu `AnalyzeWorkerHost` tüketir (`ANALYZE_CONCURRENCY`, varsayılan 4); ilan başına Redis kilidi eşzamanlı analizi engeller.
- Olay türetme DB'den: son analizdeki `listingPrice`/`listingContentHash` ile güncel ilan karşılaştırılır. `NEW`/`PRICE_DROP`/`RELIST` → `match` kuyruğu (Plan 04). Kuyruğa alınamayan olaylar scheduler tarafından 60 sn sonra yeniden gönderilir.
- Scheduler İstanbul saatiyle 03:00'ten sonra günde bir kez tüm aktif ilanlar için `REFRESH` işi üretir; bu analizler `REFRESH` olarak yeniden bildirim üretmez (yalnızca ilanı daha eşleşebilir yapan `REFRESH`/`CHANGE` bir `NEW` üretir), düşük öncelikle (`priority: 100`) kuyruğa girer. Başarılı bir tarama sonrası, o taramada ilk görülen `INSUFFICIENT`/analizsiz ilanlar için `analyze-post-*` `REFRESH` işleri eklenir. Kuralların ayrıntısı: [analysis-engine.md](analysis-engine.md).

## Eşleştirme (Plan 04)
Akış: `scrape` → ingest → `analyze` (olay türetme) → `match` → `ListingMatch` → `Notification` → `notify`/`notify-telegram` (Plan 05).

- `MatchWorkerHost` `match` kuyruğunu `MATCH_CONCURRENCY` (varsayılan 4) paralellikle tüketir; `MatchService` ilan başına advisory kilit altında `@oto/db` `matchPredicate` ile ACTIVE profilleri bulur, `decideMatchReason` ile nedeni (`NEW`/`PRICE_DROP`/`RELIST`) belirler ve `ListingMatch`'i `ON CONFLICT DO NOTHING` ile yazar.
- API tarafında `/me/search-profiles` (CRUD, duraklat/sürdür, önizleme, plan limitleri) ve `/me/matches` (cursor sayfalama) userId kapsamlı repository'lerle çalışır; önizleme aynı `matchPredicate`'i ters yönde kullanır.
- Ingest, yeni externalId ile gelen ve son 7 günde kaldırılmış bir ilanın ikizini bulursa RELIST yolunu izler.
- Ayrıntılar: [matching.md](matching.md).

## Bildirimler (Plan 05)
Akış: `ListingMatch` + `Notification(PENDING)` (aynı transaction) → commit → `notify` / `notify-telegram` kuyruğu → adapter → `SENT`/`FAILED`. Ayrıntılar: [notifications.md](notifications.md).

- **Paketler:** `@oto/telegram` (framework'süz Bot API istemcisi, hata sınıflandırması, mesaj şablonu, test için `FakeTelegramApi`).
- **Worker:** `NotificationPlanner` (kanal seçimi + günlük limit, kullanıcı başına advisory kilit), `NotificationDispatcher` (commit sonrası kuyruğa ekleme, `jobId = notify-<id>`), `NotifyWorkerHost` (`NOTIFY_CONCURRENCY`; `notify-telegram` için limiter 25/sn), `NotifyService` + `InAppAdapter` (Redis pub/sub `user:<id>`) / `TelegramAdapter` (sohbet başına 1 msj/sn kapısı). Kaybolan kuyruk işlerini scheduler süpürmesi 60 sn sonra yeniden ekler. Teslim garantisi en az bir kezdir.
- **API:** `/me/notifications` (liste, okundu, canlı SSE akışı `ready`/`notification`/`ping`, 15 dk), `/me/channels` (Telegram bağlama/aç-kapat/kaldır), `/telegram/webhook` (gizli anahtar başlığı) veya geliştirmede `getUpdates` yoklaması. `UserEventsService` tek Redis desen aboneliğini SSE akışlarına dağıtır.
- **Gizlilik:** kanal `config`'i (chatId) AES-256-GCM şifreli; API yanıtları ve loglar chatId veya bot token'ı içermez.

## Web katmanı (Plan 06)
Ayrıntılar: [web.md](web.md).

- `apps/web` (Next.js 15 App Router, React 19, TanStack Query) tarayıcının tek muhatabıdır; `/api/*` Next `rewrites` ile API'ye (`API_ORIGIN`, build zamanında sabit) yönlenir, böylece çerezler birinci taraftır. Üretimde tek origin Caddy ile sağlanacaktır (Plan 08).
- **Oturum:** `middleware.ts` `/app/*` için `access_token` çerezine bakar; yoksa girişte tek seferlik istemci yenilemesi (`try_refresh`, `_r` döngü koruması). `apiFetch` 401'de tek uçuşlu, üç durumlu (`ok|expired|transient`) yenileme yapar; yalnızca `expired` oturumu bitirir.
- **Canlı bildirim:** tek SSE bağlantısı (`ready`/`notification`/`ping`), 60 sn watchdog, 14 dk 30 sn'de proaktif yenileme, oturum bitince durur.
- **Panel API'leri (Plan 06):** `/me/opportunities`, `/me/listings/:id`, `/me/favorites`, `/me/dashboard`, `/me/subscription`, `/catalog/*` — hepsi userId kapsamlı repository'ler üzerinden; `Favorite.id` (SERIAL, benzersiz) keyset imleci içindir.
- **Tasarım sistemi:** CSS tokenları `globals.css`'te; koyu varsayılan, açık tema WCAG AA; yazı tipleri self-hosted (derleme ağsızdır). Plan 07 admin paneli aynı sistemi kullanacaktır.
