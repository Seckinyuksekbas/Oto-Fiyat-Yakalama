# Plan 08 — Üretim ve Uçtan Uca Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Platformu tek komutla üretime alınabilir hale getirmek. Kapsam:
- Prod `docker-compose.yml`: Caddy tek origin, web/api/worker/scheduler, Postgres/Redis, migrate, backup servisleri.
- Non-root multi-stage Dockerfile'lar.
- Production ortam doğrulaması, güvenlik başlıkları ve CSP.
- Saklama (retention) / KVKK temizliği.
- Yedekleme ve geri yükleme testi.
- Spec §10'daki Playwright uçtan uca senaryoları: kullanıcı ve admin.
- CI'da gizli bilgi taraması, web build ve E2E.
- Operasyon dokümanları.
- Plan 01–07'den "Plan 08"e taşınan sertleştirme ve test borçları.

**Architecture:**
- **Uygulama kodu:**
  - Production'a özgü kurallar her uygulamanın zod `Env` şemasında `superRefine` ile uygulanır; eksik ya da güvensiz yapılandırmada süreç açılmaz.
  - Saklama işleri scheduler'ın günlük `cleanup` adımında toplu (batch) silmeyle çalışır.
  - Scheduler tekliği Redis lider kilidiyle sağlanır.
- **Altyapı:**
  - Dockerfile'lar `pnpm deploy --prod` ile uygulama başına izole bağımlılık ağacı çıkarır.
  - Web `output: 'standalone'` ile çalışır.
  - Caddy `/api/*` isteklerini api'ye, geri kalanını web'e yönlendirir; HTTPS/HSTS Caddy'dedir.
- **E2E:** Ayrı `apps/e2e` paketindeki Playwright testleri derlenmiş süreçlere (`node dist/main.js`, `next start`) karşı koşar. Bileşenler:
  - Sahte Telegram Bot API sunucusu
  - E-posta doğrulaması için Mailpit API'si
  - Fırsat enjeksiyonu için demo-site `/__inject`

**Tech Stack:** Docker (multi-stage, `node:22-alpine`), Caddy 2, Postgres 16, Redis 7 (AOF), `pg_dump -Fc` / `pg_restore`, Playwright 1.64 (`@playwright/test`), GitHub Actions (gitleaks), NestJS 11, Prisma 6, BullMQ 5, Next.js 15.5.

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`. İlgili bölümler:
- §6: Topoloji, Oturum, Girdi sertleştirme (CSP), Gizli veriler, KVKK ve saklama, Yedekleme, Ertelenenler
- §9: graceful shutdown, health
- §10: Playwright
- §11: Dağıtım ve Dokümantasyon

Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md` — tüm "Plan 08" taşınan maddeleri. Admin kuralları: `docs/admin.md`. Web kuralları: `docs/web.md`.

## Bu planın kararları (spec'i netleştiren)

| Konu | Karar | Gerekçe |
|---|---|---|
| Admin 2FA | Bu planda YOK: spec §6 "Ertelenenler" (Aşama 3); yol haritasında "Plan dışı"ya taşınır | Spec §6 |
| Prod env (api) | `superRefine` production'da şunları zorunlu kılar: `COOKIE_SECURE=true`; `PUBLIC_BASE_URL` https ve localhost/loopback değil; `MAIL_TRANSPORT=smtp`; `SMTP_HOST` localhost değil. Ayrıca yeni değişkenler: `TRUST_PROXY` (int 0–5, varsayılan 1; `app.set('trust proxy', n)`), `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` (bool) ve `SMTP_REQUIRE_TLS` (bool, prod varsayılanı true). `PORT` doğrulanmış `Env`'den okunur | Plan 01 notları |
| JWT self-test | Açılışta test payload'ı imzalanıp aynı açık anahtarla doğrulanır; çift uyuşmazsa süreç başlamaz | Plan 01 notu |
| Refresh mutlak ömür | `Session.familyStartedAt` (migration, mevcut satırlar `createdAt` ile doldurulur). Rotasyon `familyStartedAt`'ı taşır; `now − familyStartedAt > 90 gün` ise refresh 401 + aile iptal edilir | Plan 01 notu |
| Forgot-password bekleme | E-posta başına 60 sn Redis NX (resend-verification ile aynı desen); bekleme sırasında yanıt yine 204 (enumeration yok) | Plan 01 notu |
| İnteraktif tx | `createWithinLimit` / `resumeWithinLimit` ve diğer advisory-lock tx'leri `{ maxWait: 10_000, timeout: 15_000 }`; Prisma `P2028` → 503 `SERVICE_BUSY` (yeni `ErrorCode`) | Plan 04 final notu |
| Saklama | Günlük `cleanup` adımı, her sorgu 5000'lik batch'lerle siler: SystemLog/ScrapeError/ListingIssue 30 gün (mevcut); AuditLog 365 gün; Notification 90 gün (`createdAt`); süresi dolmuş/iptal Session 30 gün; kullanılmış/süresi dolmuş token tabloları 7 gün; `ListingAnalysis` 90 günden eski olanlar — ancak yalnızca `latestAnalysisId` olarak referanslanmayan VE hiçbir `ListingMatch` tarafından referanslanmayan satırlar | Spec §6; Plan 04/07 notları |
| Scheduler tekliği | Redis `scheduler:leader` kilidi (`SET NX PX 30000`, 10 sn'de bir Lua CAS ile yenilenir). Kilidi alamayan scheduler tick yapmaz, `info` log yazar ve beklemede kalır; kilit kaybedilirse tick durur | Plan 02 notu |
| Graceful shutdown | Worker'da `SHUTDOWN_TIMEOUT_MS` (varsayılan 30000). `onModuleDestroy` önce `worker.close()` dener; süre aşılırsa `worker.close(true)` (force) çağırır ve aktif işler stalled olarak yeniden işlenir. Compose `stop_grace_period: 45s` | Spec §9; Plan 02 notu |
| Seed | `NODE_ENV=production` iken `SEED_DEMO_SOURCE=true` → seed hata verip çıkar | Plan 02 notu |
| connection_limit | Worker açılışta `DATABASE_URL`'deki `connection_limit` değerini okur. Production'da değer yoksa ya da `< SCRAPE+ANALYZE+MATCH+NOTIFY_CONCURRENCY + 3` ise süreç başlamaz; dev'de yalnız uyarır | Plan 04 notu |
| Telegram | Webhook işleyici hatası → 500 (Telegram yeniden dener); bağlama işleyicisinde geçici DB hatası "kod geçersiz" değil 500. `scripts/telegram-webhook.mjs set|info|delete` (Bot API `setWebhook` + `secret_token`, `getWebhookInfo`). Rotasyon prosedürü dokümanda. Worker production'da `TELEGRAM_BOT_TOKEN` yoksa açılışta `warn` yazar ve `SystemLog` kaydı düşer; tutarlılık docs/operations'da | Plan 05 notu |
| Admin duraklatma | `POST /admin/sources/:id/pause` yalnız `isActive=false` yazar (health'e dokunmaz); `activate` engel kaynaklı PAUSED'ı da sıfırlar (mevcut). Dry-run `health=PAUSED` (engel) olmadıkça çalışır | Plan 07 notu |
| Config gizli anahtarları | Kaynak `config` içindeki anahtar adı `/(key|token|secret|pass(word)?|auth)/i` olan string değerler yanıtlarda ve audit before/after'da `"***"` olarak maskelenir. PATCH'te değer `"***"` gelirse saklı değer korunur | Plan 07 notu |
| CSP | Next middleware'i olmadan, `next.config.mjs` `headers()` ile statik CSP. Satır içi tema betiği için derleme anında hesaplanan `sha256-…` hash'i kullanılır (betik statik string). Direktifler: `default-src 'self'; script-src 'self' 'sha256-<theme>' (+ dev'de 'unsafe-eval'); style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. Next 15 App Router'ın kendi inline betikleri için `script-src`'e `'unsafe-inline'` EKLENMEZ; bunun yerine strict-dynamic gerekip gerekmediği build çıktısında test edilir (Task 7 adımı) | Spec §6; Plan 06/07 notları |
| HSTS | Caddy: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (yalnız prod sitesinde) | Spec §6 |
| Gizli bilgi taraması | CI'da `gitleaks/gitleaks-action@v2` + repoda `.gitleaks.toml`; test sabitlerinde token biçimli literal yasak (çalışma anında üretilir) | GitHub uyarısı (2026-10-11) |
| E2E çalıştırma | `apps/e2e` Playwright projesi; `global-setup` derlenmiş süreçleri ayrı portlarda başlatır: api 3101, web 3100, demo-site 4100, sahte Telegram 4200, Mailpit 8025 (dev compose). Veritabanı `oto_e2e` (dev Postgres'te ayrı DB, migrate + seed); Redis db 14 | Spec §10 |

## Global Constraints

- Plan 01–07 Global Constraints maddeleri geçerlidir.
- Kaynak etiği değişmez: E2E ve smoke yalnızca demo-site'a karşı çalışır; Sahibinden/Arabam adapter'ı yok; stealth, captcha çözme, UA sahteciliği ve proxy rotasyonu yok.
- **Gizli bilgiler:**
  - Gerçek token, anahtar ya da parola repoya girmez; yalnızca gitignore'lu `.env` / `.env.prod`'da durur.
  - Testlerde token biçimli literal yazılmaz, çalışma anında üretilir: `['123456789', 'TEST'.padEnd(35, 'x')].join(':')`.
  - `.env.example` yalnızca yer tutucu içerir.
- **Konteynerler:**
  - Non-root (`USER node`).
  - Healthcheck'li.
  - Gizli bilgiler build argümanı olarak verilmez; yalnızca runtime env kullanılır.
- **Production süreçleri:**
  - Eksik ya da güvensiz env'de açılmaz.
  - Hata mesajı hangi değişkenin neden reddedildiğini söyler, değerini yazdırmaz.
- **Saklama:**
  - `ListingMatch` tarafından referanslanan `ListingAnalysis` asla silinmez.
  - Cascade ile eşleşme silinmez; NEW yeniden tetiklenmez.
- **Docker ortamı (Windows):** Komutlar Git Bash ile çalışır; scriptler `#!/usr/bin/env sh` POSIX olmalı ve konteyner içinde (alpine) çalışmalı.
- **Kullanıcı arayüzü:** Türkçe. Dokümanlar Türkçe.

## Review Focus

1. **Eksik ya da güvensiz production env** (`COOKIE_SECURE=false`, `http://` ya da localhost `PUBLIC_BASE_URL`, `connection_limit` yok, eşleşmeyen JWT çifti):
   - Süreç açılmaz.
   - Mesaj değişken adını verir, değeri sızdırmaz.
   - Test: Task 1, Task 4.
2. **Saklama işi referanslı satırlara dokunuyor:**
   - `ListingMatch`'li ya da `latestAnalysisId` olan analiz silinirse eşleşme kaybolur, NEW yeniden tetiklenir.
   - Test kurgusu: 100+ gün eski referanslı ve referanssız satırlar kurulur; yalnız referanssız olan silinir ve hiçbir eşleşme ya da bildirim kaybolmaz.
   - Test: Task 3.
3. **İki scheduler aynı anda çalışırsa ya da lider ölürse:**
   - Yalnız biri tick yapar.
   - Kilit süresi dolunca diğeri devralır.
   - Çift tarama işi oluşmaz.
   - Test: Task 4.
4. **CSP sayfayı kırar** (tema betiği engellenir ya da Next hydration betikleri bloke olur):
   - Prod build'de tüm sayfalar konsol CSP hatası olmadan çalışmalı.
   - Test: Task 7 (Playwright konsol kontrolü) ve Task 11.
5. **Yedekten geri yükleme:**
   - `restore-test.sh` en son dump'ı geçici DB'ye açar.
   - Migration tablosu ve kritik tablo sayımları kaynakla eşleşmeli.
   - Bozuk ya da boş dump'ta script sıfırdan farklı kodla çıkar.
   - Test: Task 10.

---

### Task 1: Production env doğrulaması ve açılış self-test'leri (api + worker + web + seed)

**Files:**
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/main.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/modules/mail/mail.service.ts` (SMTP auth/TLS), `apps/api/src/modules/auth/token.service.ts` (self-test)
- Modify: `apps/worker/src/config/env.ts`
- Modify: `packages/db/prisma/seed.ts`
- Create: `apps/web/src/env.ts`
- Modify: `apps/web/next.config.mjs` (`API_ORIGIN` zod)
- Test:
  - `apps/api/src/config/env.spec.ts`
  - `apps/worker/src/config/env.spec.ts`
  - `apps/api/src/modules/auth/token.service.spec.ts`
  - `packages/db/prisma/seed.spec.ts` (ya da seed'in saf `assertSeedEnv` fonksiyonu için birim testi)

**Interfaces:**
- **Produces:** `Env.TRUST_PROXY: number`, `Env.SMTP_USER?: string`, `Env.SMTP_PASS?: string`, `Env.SMTP_SECURE: boolean`, `Env.SMTP_REQUIRE_TLS: boolean`, `Env.SHUTDOWN_TIMEOUT_MS: number` (worker), `assertSeedEnv(env): void` (`packages/db/prisma/seed-env.ts`).
- **Consumes:** mevcut `parseEnv` deseni.

- [ ] **Step 1: Testler**
  - **api env:** prod + `COOKIE_SECURE=false` → hata mesajında `COOKIE_SECURE` geçer. Aynı şekilde şu durumların her biri ayrı test:
    - `PUBLIC_BASE_URL=http://example.com`
    - `PUBLIC_BASE_URL=https://localhost`
    - `MAIL_TRANSPORT=json`
    - `SMTP_HOST=localhost`
  - **Geçerli prod yapılandırması:** parse olur, `TRUST_PROXY` varsayılanı 1.
  - **Gizli değer sızmaz:** hata mesajı `JWT_PRIVATE_KEY` değerini içermez (değer olarak rastgele üretilmiş bir string verilip `not.toContain` ile kontrol).
  - **worker env:** `SHUTDOWN_TIMEOUT_MS` varsayılanı 30000.
  - **token self-test:** farklı çiftlerden private/public verilince `onModuleInit` reddeder. Anahtarlar testte `generateKeyPair('Ed25519')` ile üretilir; literal anahtar yok.
  - **seed:** prod + `SEED_DEMO_SOURCE=true` → `assertSeedEnv` fırlatır.
  - **web env:** `API_ORIGIN` geçersiz URL ise fırlatır.
  - Hepsi FAIL.
- [ ] **Step 2: Uygula**
  - `superRefine` kuralları.
  - `bootstrap.ts`'de `app.set('trust proxy', env.TRUST_PROXY)`.
  - `main.ts` portu `env.PORT`'tan okur.
  - `mail.service.ts`: `createTransport({ host, port, secure: env.SMTP_SECURE, requireTLS: env.SMTP_REQUIRE_TLS, auth: env.SMTP_USER ? { user, pass } : undefined })`.
  - Token self-test: `SignJWT` + `jwtVerify` gidiş-dönüşü.
- [ ] **Step 3: Doğrulama**
  - `.env.example`'a yeni değişkenler açıklamalı olarak eklenir; yalnız yer tutucu.
  - Testler PASS.
  - `pnpm --filter @oto/api test`, `pnpm --filter @oto/worker test`, typecheck.
- [ ] **Step 4: Commit** `feat(config): production env validation, SMTP auth/TLS, TRUST_PROXY, JWT key self-test`

---

### Task 2: Oturum, şifre sıfırlama ve transaction sertleştirmeleri (api)

**Files:**
- Create: `packages/db/prisma/migrations/20261018000000_session_family_started/migration.sql`
  - `ALTER TABLE "Session" ADD COLUMN "familyStartedAt" TIMESTAMP(3);`
  - `UPDATE "Session" s SET "familyStartedAt" = (SELECT MIN("createdAt") FROM "Session" f WHERE f."familyId" = s."familyId");`
  - `ALTER ... SET NOT NULL, SET DEFAULT CURRENT_TIMESTAMP`
- Create: aynı migration'da `CREATE INDEX "Favorite_userId_id_idx" ON "Favorite"("userId","id");`
- Modify: `schema.prisma`
- Modify: `apps/api/src/modules/auth/session.service.ts`, `auth.constants.ts` (`REFRESH_FAMILY_MAX_MS = 90 gün`)
- Modify: `apps/api/src/modules/auth/password-reset.service.ts`
- Modify: `apps/api/src/modules/me/search-profiles.repository.ts`
- Modify: `apps/api/src/common/errors/*` (`SERVICE_BUSY`, P2028 eşlemesi `AllExceptionsFilter`'da)
- Test: `apps/api/test/auth-hardening.e2e.spec.ts`

**Interfaces:**
- **Produces:**
  - `ErrorCode.SERVICE_BUSY` (HTTP 503).
  - `Session.familyStartedAt: Date`.

- [ ] **Step 1: Testler** (önce hepsi FAIL olmalı)
  - **Aile ömrü sınırı:**
    - Bir ailenin `familyStartedAt` değeri 91 gün geriye çekilir (doğrudan SQL ile).
    - Refresh isteği 401 dönmeli ve ailenin tüm oturumları revoke edilmeli.
    - 89 günlük ailede refresh çalışmalı.
    - Rotasyondan sonra `familyStartedAt` korunmalı (değişmemeli).
  - **Forgot-password beklemesi:** Aynı e-postaya 2 hızlı istek gönderilir.
    - İki yanıt da 204 olmalı.
    - Mailpit/JSON transport'ta tek mail görülmeli.
    - 60 sn sonra (Redis key TTL elle silinerek) ikinci mail gitmeli.
  - **Transaction zaman aşımı:** `createWithinLimit` sırasında advisory lock başka bir bağlantıda 12 sn tutulur.
    - İstek 503 `SERVICE_BUSY` dönmeli, 500 dönmemeli.
- [ ] **Step 2: Uygulama**
  - Migration'ı yaz.
  - `session.service`: rotasyonda `familyStartedAt` yeni oturuma kopyalanmalı; refresh'te ailenin yaş kontrolü yapılmalı.
  - Forgot-password beklemesi için Redis NX: `auth:forgot:<sha256(email)>` (e-posta düz yazılmaz).
  - Transaction seçenekleri: `{ maxWait: 10_000, timeout: 15_000 }`.
  - `AllExceptionsFilter`'da Prisma `P2028` → 503 eşlemesi.
- [ ] **Step 3: Doğrulama** Testler PASS. Ayrıca şunlar da geçmeli: `pnpm --filter @oto/api test:e2e`, `prisma migrate diff` (temiz).
- [ ] **Step 4: Commit** `feat(auth): absolute refresh family lifetime, forgot-password cooldown, tx timeouts → 503`

---

### Task 3: Saklama (retention) ve KVKK temizliği (worker)

**Files:**
- Create: `apps/worker/src/scheduler/retention.service.ts`
- Modify: `apps/worker/src/scheduler/scheduler.service.ts`: `cleanup()` RetentionService'e taşınır.
- Modify: `apps/worker/src/scheduler/scheduler-loop.service.ts`
- Create: migration `20261018000001_retention_indexes` (gerekiyorsa)
  - `AuditLog("createdAt")`
  - `Session("expiresAt")`
  - `ListingAnalysis("createdAt")`
  - `EXPLAIN` ile kontrol et.
- Test: `apps/worker/test/retention.e2e.spec.ts`

**Interfaces:**
- **Produces:** `RetentionService.run(now: Date): Promise<Record<string, number>>`. Tablo başına silinen satır sayısını döner.
- **Sabitler:**
  - `RETENTION = { systemLogDays: 30, scrapeErrorDays: 30, listingIssueDays: 30, auditLogDays: 365, notificationDays: 90, sessionDays: 30, tokenDays: 7, analysisDays: 90 }`

- [ ] **Step 1: Testler**
  - Her tablo için iki satır kurulur: sınırın 1 gün öncesi (silinir) ve 1 gün sonrası (kalır).
  - **Kritik:** 100 günlük `ListingAnalysis` üç türde kurulur:
    - (a) referanssız → silinir
    - (b) `Listing.latestAnalysisId` → kalır
    - (c) `ListingMatch.analysisId` referanslı → kalır
  - (c) için ek doğrulama: `ListingMatch` ve `Notification` sayısı değişmez.
  - **Batch:** 12.000 eski SystemLog satırı tek `run`'da silinir; batch'ler 5000'lik olur ve sorgu sayısı ≥ 3 olur.
  - Dönen sayılar doğru olmalı.
  - FAIL.
- [ ] **Step 2: Uygulama**
  - Batch silme: `DELETE FROM "X" WHERE id IN (SELECT id FROM "X" WHERE <koşul> LIMIT 5000)`, 0 dönene kadar döngü.
  - Analiz silme koşulu:
    - `createdAt < now-90d`
    - `AND NOT EXISTS (SELECT 1 FROM "Listing" l WHERE l."latestAnalysisId" = a.id)`
    - `AND NOT EXISTS (SELECT 1 FROM "ListingMatch" m WHERE m."analysisId" = a.id)`
    - FK alan adlarını şemadan doğrula.
  - Sonuç `info` log'u (tablo → sayı).
- [ ] **Step 3: Doğrulama** PASS; worker e2e tam koşu.
- [ ] **Step 4: Commit** `feat(worker): retention for audit, notifications, sessions, tokens and unreferenced analyses (KVKK)`

---

### Task 4: Worker işletim sertleştirmeleri

**Files:**
- Create: `apps/worker/src/scheduler/leader-lock.service.ts`
- Modify: `scheduler-loop.service.ts` (tick/cleanup/monitor yalnız liderken)
- Modify: tüm `*-worker.host.ts` (`closeWithTimeout`)
- Create: `apps/worker/src/common/close-with-timeout.ts`
- Modify: `apps/worker/src/config/env.ts` (`connection_limit` kontrolü)
- Test:
  - `apps/worker/test/leader-lock.e2e.spec.ts`
  - `apps/worker/src/common/close-with-timeout.spec.ts`
  - `apps/worker/src/config/env.spec.ts` (ek)
  - Plan 07 test borçları:
    - `apps/worker/test/scheduler.e2e.spec.ts`: uygunluk kilit altında yeniden okunur
    - `apps/worker/test/monitor.e2e.spec.ts`: `MONITOR_INTERVAL_MS` kısıtlayıcı

**Interfaces:**
- **Produces:**
  - `LeaderLockService { tryAcquire(): Promise<boolean>; isLeader(): boolean; release(): Promise<void> }`
    - Anahtar `scheduler:leader`.
    - Değer `<host>:<pid>:<uuid>`.
    - PX 30000, yenileme 10 sn, Lua CAS.
  - `closeWithTimeout(worker: { close(force?: boolean): Promise<void> }, ms: number, logger)`

- [ ] **Step 1: Testler**
  - **Lider kilidi:**
    - İki `LeaderLockService` örneği aynı Redis'te: yalnız biri lider olur.
    - Lider `release` ederse ya da yenilemeyi durdurursa (fake timer + PX süresi dolar) diğeri devralır.
    - Lider olmayan loop `tick` çağırmaz (spy).
  - **`closeWithTimeout`:**
    - `close()` 100 ms sınırını aşarsa `close(true)` çağrılır.
    - Sınır içinde biterse force çağrılmaz.
  - **`connection_limit` (env):**
    - prod + `DATABASE_URL` `connection_limit` yok → hata.
    - `connection_limit=5` ve concurrency toplamı 18 → hata.
    - dev'de yalnız uyarı.
  - **Plan 07 test borçları:**
    - Scheduler, kilit alındıktan sonra kaynağın pasifleştiği durumda iş oluşturmaz.
    - Monitör `MONITOR_INTERVAL_MS` içinde ikinci kez çalışmaz.
  - FAIL.
- [ ] **Step 2: Uygulama**
  - **Lider kilidi:** yenileme için `setInterval`. Kilit kaybedilirse `isLeader=false` olur ve warn log yazılır.
  - **Kapatma:** `onApplicationShutdown` sırasında kilit release edilir.
  - **`closeWithTimeout`:** worker host'larının hepsi bunu kullanır.
- [ ] **Step 3: Doğrulama** PASS; worker e2e tam koşu.
- [ ] **Step 4: Commit** `feat(worker): scheduler leader lock, bounded graceful shutdown, connection_limit guard`

---

### Task 5: Telegram üretim sertleştirmeleri (api)

**Files:**
- Modify: `apps/api/src/modules/telegram/telegram-webhook.controller.ts`, `telegram-update.handler.ts`
- Create: `scripts/telegram-webhook.mjs`
- Modify: `package.json` (`"telegram:webhook": "node scripts/telegram-webhook.mjs"`)
- Test: `apps/api/test/telegram-webhook.e2e.spec.ts` (ek), `scripts/telegram-webhook.spec.mjs` ya da `scripts/__tests__` (vitest, sahte Bot API ile)

**Interfaces:**
- **Produces:** `node scripts/telegram-webhook.mjs set|info|delete`
  - Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, opsiyonel `TELEGRAM_API_BASE`.
  - `set` şunu çağırır: `setWebhook { url: PUBLIC_BASE_URL + '/api/v1/telegram/webhook', secret_token, allowed_updates: ['message','callback_query'], drop_pending_updates: false }`.
  - Çıktıda token maskelenir.

- [ ] **Step 1: Testler** (FAIL)
  - Handler `throw` ederse webhook 500 döner, 200 değil. Kanıt: `vi.spyOn` ile handler hatası.
  - Bağlama sırasında Prisma geçici hatası (`P1001`) olursa kullanıcıya "kod geçersiz" mesajı GÖNDERİLMEZ (sahte Bot API'ye mesaj yok) ve yanıt 500 olur.
  - Gerçekten geçersiz kod hâlâ "kod geçersiz" mesajıyla 200 döner.
  - Script:
    - Sahte Bot API'ye doğru gövdeyi gönderir.
    - Token stdout'ta görünmez.
    - Eksik env'de 1 ile çıkar.
- [ ] **Step 2: Uygulama**
  - Controller'daki try/catch kaldırılır; hata `AllExceptionsFilter`'a gider ve 500 döner. Log'a `update_id` yazılır.
  - Handler'da yalnızca "kod bulunamadı/süresi dolmuş" durumu kullanıcı mesajı üretir; diğer hatalar yeniden fırlatılır.
- [ ] **Step 3: Doğrulama** PASS
- [ ] **Step 4: Commit** `fix(telegram): let Telegram retry failed updates; webhook setup script`

---

### Task 6: Admin/kaynak borçları ve api kararsızlığı

**Files:**
- Modify: `apps/api/src/modules/admin/sources.service.ts` (pause yalnız `isActive=false`; config gizli anahtar maskesi + `"***"` koruma)
- Modify: `apps/worker/src/collection/scrape-runner.service.ts` (dry-run engel kaynaklı PAUSED dışında çalışır)
- Modify: `apps/web/src/app/admin/kaynaklar/**` (kopya ve duraklat/etkinleştir rozetleri: "Duraklatıldı (yönetici)" vs "Engel nedeniyle duraklatıldı")
- Modify: `docs/admin.md`
- Test:
  - `apps/api/test/admin-sources.e2e.spec.ts`
  - `apps/worker/test/scrape-runner.e2e.spec.ts`
  - `apps/web/src/app/admin/kaynaklar/sources.spec.tsx`
- Plan 07 test borcu: `apps/api/test/admin-sources-hardening.e2e.spec.ts`. Proxy kontrolü sürerken URL değişirse sonuç eski URL için yazılmaz ve audit üretilmez. Yavaş sahte proxy ile.

**Interfaces:**
- **Produces:** `maskConfigSecrets(config: Record<string, unknown>): Record<string, unknown>` ve `mergeMaskedConfig(stored, patch)` (`apps/api/src/modules/admin/config-mask.ts`).

- [ ] **Step 1: Testler**
  - **Pause:**
    - `pause` → `isActive=false`, health değişmez.
    - Dry-run duraklatılmış (admin) kaynakta 202 ile çalışır.
    - Engel kaynaklı `health=PAUSED`'da hâlâ 409.
    - Monitör admin-pause'da alarm üretmez; mevcut davranış korunur.
  - **Config maskesi:**
    - Test verisi: `config: { baseUrl, apiKey: <çalışma anında üretilen 32 karakter> }`.
    - GET yanıtında `apiKey: "***"` döner.
    - Audit before/after'da düz değer yok.
    - PATCH'te `apiKey: "***"` gönderilirse saklı değer korunur (DB'den okunarak doğrulanır).
  - **Web:** iki PAUSED türü farklı rozet ve kopya gösterir.
  - **Proxy URL yarışı:** yukarıdaki test.
  - Hepsi FAIL.
- [ ] **Step 2: Uygula**
- [ ] **Step 3: Kararsızlık araştırması**
  - `pnpm --filter @oto/api test` 30 kez döngüde koşulur:
    ```bash
    for i in $(seq 30); do pnpm --filter @oto/api test --silent || echo FAIL $i; done
    ```
  - Başarısız test belirlenirse kökü düzeltilir. Belirlenemezse 30/30 sonucu rapora yazılır.
- [ ] **Step 4:** Testler PASS → **Commit:** `fix(admin): pause means inactive only, mask config secrets, proxy check race test`

---

### Task 7: Web üretim yapılandırması — standalone, CSP, tema rengi

**Files:**
- Modify: `apps/web/next.config.mjs` (`output: 'standalone'`, CSP + HSTS hariç başlıklar, `outputFileTracingRoot` monorepo kökü)
- Create: `apps/web/src/lib/csp.ts` (`themeScriptHash()`, `buildCsp({ dev })`)
- Modify: `apps/web/src/app/layout.tsx` (`viewport.themeColor` dizisi: `[{ media: '(prefers-color-scheme: dark)', color: '#0E0F11' }, { media: '(prefers-color-scheme: light)', color: <light bg token> }]`; kökte `matchMedia` dinleyicisi tema `system` iken `data-theme`'i günceller)
- Modify: `apps/web/src/lib/theme.ts`
- Test:
  - `apps/web/src/lib/csp.spec.ts`
  - `apps/web/src/app/layout.spec.tsx` (ya da mevcut tema testleri)
  - `apps/e2e/tests/csp.spec.ts` (Task 11 altyapısıyla). Bu Task'ta geçici olarak `apps/web/scripts/csp-check.mjs` kullanılır: Playwright ile prod build'e karşı tüm genel sayfaları gezer ve `securitypolicyviolation` / konsol hatası sayar.

**Interfaces:**
- **Produces:**
  - `buildCsp({ dev: boolean }): string`
  - `themeScriptHash(): string` (`'sha256-<base64>'`, `themeInitScript`'ten hesaplanır)

- [ ] **Step 1: Testler** (önce hepsi FAIL olmalı)
  - **Hash doğruluğu:** `themeScriptHash()` sonucu, `crypto.createHash('sha256')` ile `themeInitScript` üzerinden bağımsız olarak hesaplanan değere eşit.
  - **Direktifler:** `buildCsp({dev:false})` şunları içerir:
    - `frame-ancestors 'none'`
    - `object-src 'none'`
    - hash
  - **Dev ayrımı:** `'unsafe-eval'` YALNIZ `dev: true` ise vardır.
  - **themeColor:** iki medya girdisi var.
  - **Sistem teması:** tema `system` iken sistem teması değişince `data-theme` güncellenir.
- [ ] **Step 2: Uygula**
  - CSP'yi `headers()` içine ekle.
  - `pnpm --filter @oto/web build && pnpm --filter @oto/web start` sonrası `csp-check.mjs` çalıştır. Next'in kendi inline betikleri (`self.__next_f`) CSP ihlali üretirse kararı uygula: Next 15'in desteklediği nonce yaklaşımına geç.
    - `middleware.ts`'de istek başına nonce üret.
    - `x-nonce` header'ı ekle.
    - CSP'yi middleware'de yaz.
    - Kök layout'ta `headers()`'tan nonce'u alıp tema betiğine ver.
    - Seçilen yolu raporla.
  - Her iki yolda da `'unsafe-inline'` script-src'e girmez.
- [ ] **Step 3: Doğrula** `csp-check` 0 ihlal → web test/typecheck/build PASS
- [ ] **Step 4: Commit** `feat(web): standalone output, CSP without unsafe-inline scripts, media-aware theme color`

---

### Task 8: Dockerfile'lar

**Files:**
- Create: `.dockerignore` (node_modules, dist, .next, .env*, !.env.example, .git, apps/web/.screenshots, coverage, .superpowers)
- Create: `docker/api.Dockerfile`, `docker/worker.Dockerfile`, `docker/web.Dockerfile`, `docker/migrate.Dockerfile`
- Create: `docker/healthcheck-worker.mjs`
- Test: `scripts/docker-build-check.sh`

**Interfaces:**
- **Produces:** imajlar `oto/api`, `oto/worker`, `oto/web`, `oto/migrate`.
  - **Komutlar:**
    - api: `node dist/main.js`
    - worker: `node dist/main.js`; scheduler aynı imajla, komut `node dist/main.js --role=scheduler`
    - web: `node server.js`
    - migrate: `prisma migrate deploy && (SEED_ON_MIGRATE=true ise) node prisma/seed.js`
  - **Healthcheck'ler:**
    - api: `wget -qO- http://127.0.0.1:3001/api/v1/health/ready`
    - web: `wget -qO- http://127.0.0.1:3000/`
    - worker: `node /app/healthcheck-worker.mjs` — Redis'te `worker:heartbeat:<hostname>:*` key'i var mı.

- [ ] **Step 1: Test scripti**
  - `scripts/docker-build-check.sh` 4 imajı build eder.
  - Her imaj için şunları doğrular:
    - (a) `docker run --rm <img> id -u` → `1000` (non-root)
    - (b) imajda `.env` yok: `docker run --rm <img> sh -c 'test ! -e /app/.env'`
    - (c) api imajında `node -e "require('@oto/shared')"` çalışır
  - Önce FAIL (Dockerfile yok).
- [ ] **Step 2: Dockerfile'ları yaz** (aşamalar)
  - `base`: `node:22-alpine` + corepack pnpm@10.30.3.
  - `deps`: `pnpm fetch` (yalnız lockfile).
  - `build`:
    - `pnpm install --offline --frozen-lockfile`
    - `pnpm build:packages && pnpm --filter <app> build`
    - `pnpm --filter <app> deploy --prod /out`
    - Prisma client: `@oto/db` deploy çıktısında `prisma generate` gerekir; engine `linux-musl-openssl-3.0.x` → `schema.prisma` `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`.
  - `runtime`: `node:22-alpine`, `USER node`, `WORKDIR /app`, yalnız `/out` + `dist`.
  - Web: standalone çıktısı + `.next/static` + `public`. `API_ORIGIN` yalnızca build arg, gizli değil.
- [ ] **Step 3: Doğrula**
  - `sh scripts/docker-build-check.sh` PASS.
  - İmaj boyutları rapora yazılır.
- [ ] **Step 4: Commit** `build: multi-stage non-root Dockerfiles for api, worker, web and migrate`

---

### Task 9: Prod compose, Caddy, Redis kalıcılığı

**Files:**
- Create: `docker-compose.yml` (prod)
- Create: `docker/Caddyfile`
- Create: `.env.prod.example`
- Create: `docker-compose.smoke.override.yml` (yerel prod-benzeri smoke: Caddy `localhost` + `tls internal`, portlar 8443/8080, mailpit)
- Test: `scripts/prod-smoke.sh`

**Interfaces:**
- **Produces:** servisler:
  - `caddy` (80/443)
  - `web`
  - `api`
  - `worker` (`deploy.replicas: ${WORKER_REPLICAS:-2}`)
  - `scheduler` (1)
  - `postgres` (volume `pgdata`, healthcheck)
  - `redis` (`--appendonly yes`, volume `redisdata`)
  - `migrate` (one-shot; api/worker/scheduler `depends_on: migrate: condition: service_completed_successfully`)
  - `backup` (Task 10)
- **Ağ:** yalnız `caddy` dışa port açar.
- **Caddyfile:**
  - `{$SITE_ADDRESS}`
  - `handle /api/* { reverse_proxy api:3001 }`
  - `handle { reverse_proxy web:3000 }`
  - `header` HSTS + `-Server`
  - `encode zstd gzip`
  - SSE için `flush_interval -1` (`/api/v1/*/stream` yolları)

- [ ] **Step 1: Smoke testi** — `scripts/prod-smoke.sh`:
  - **Ayağa kaldırma:**
    - `docker compose -f docker-compose.yml -f docker-compose.smoke.override.yml --env-file .env.prod.smoke up -d --build --wait`
    - `.env.prod.smoke` script içinde geçici üretilir: anahtarlar `scripts/gen-keys.mjs` ile, gizli değerler `openssl rand` ile. Dosya sonunda silinir.
  - **İstek kontrolleri** (`curl -k https://localhost:8443`):
    - `/api/v1/health/ready` 200
    - `/` 200, CSP header var
    - HSTS var
    - `Server` header yok
  - **SSE akış kontrolü:**
    - Seed admin ile giriş: CSRF için `X-Requested-With` ve `Origin` gerekli.
    - `/api/v1/admin/overview` 200.
    - `/api/v1/me/notifications/stream`'den 5 sn içinde `ready` olayı gelmeli. Bu, Caddy'nin SSE akışını tamponlamadığını doğrular.
  - **Servis durumu:** worker ve scheduler `healthy`; scheduler log'unda "leader" satırı var.
  - **Kapanış:** `docker compose down -v`.
  - Önce FAIL.
- [ ] **Step 2: Uygula**
  - Compose, Caddyfile ve env örneği.
  - `.env.prod.example` her değişkeni açıklar: zorunlu mu, örnek biçim. Gerçek değer içermez.
- [ ] **Step 3: Doğrula** `sh scripts/prod-smoke.sh` PASS. Çıktı rapora yazılır.
- [ ] **Step 4: Commit** `feat(deploy): production compose with Caddy single origin, healthchecks and Redis AOF`

---

### Task 10: Yedekleme ve geri yükleme testi

**Files:**
- Create: `docker/backup.Dockerfile` (`postgres:16-alpine` + `busybox crond`)
- Create: `docker/backup/backup.sh`, `docker/backup/crontab`
- Create: `scripts/restore-test.sh`
- Modify: `docker-compose.yml` (`backup` servisi, volume `backups`)
- Test: `scripts/backup-restore-check.sh`

**Interfaces:**
- **Produces:**
  - **`backup.sh`:**
    - `pg_dump -Fc` → `/backups/daily/oto-<YYYYmmdd-HHMMSS>.dump`.
    - Pazar günü ek olarak `/backups/weekly/` kopyası.
    - Rotasyon: 7 günlük + 4 haftalık.
    - Opsiyonel S3 hedefi: `BACKUP_S3_URI` + `aws s3 cp`; yalnızca env doluysa.
    - Başarısızlıkta sıfır olmayan çıkış.
  - **`restore-test.sh [dump]`:**
    - En son dump'ı alır.
    - Geçici `oto_restore_<ts>` DB'ye `pg_restore` yapar.
    - Doğrular: `_prisma_migrations` satır sayısı kaynakla aynı ve bitmemiş migration yok; `User`/`Listing`/`ListingAnalysis` sayıları kaynakla aynı.
    - Geçici DB'yi düşürür.
    - Çıkış kodu: 0 / 1.

- [ ] **Step 1: Test**
  - `scripts/backup-restore-check.sh` (smoke compose üzerinde):
    1. Seed sonrası `backup.sh`'yi elle tetikler.
    2. `restore-test.sh` → 0 olmalı.
    3. 0 baytlık sahte dump ile `restore-test.sh` → ≠0 olmalı.
    4. Rotasyon: 10 sahte günlük dosya oluşturulur, `backup.sh` sonrası 7 kalmalı.
  - FAIL.
- [ ] **Step 2: Uygula**
- [ ] **Step 3: Doğrula** PASS; çıktı rapora yazılır.
- [ ] **Step 4: Commit** `feat(ops): nightly pg_dump backups with rotation and automated restore test`

---

### Task 11: Playwright uçtan uca testleri (kullanıcı + admin)

**Files:**
- Create: `apps/e2e/package.json` (`@oto/e2e`, `@playwright/test` `1.64.0`)
- Create: `apps/e2e/playwright.config.ts`
- Create: `apps/e2e/global-setup.ts`, `apps/e2e/global-teardown.ts`
- Create: `apps/e2e/support/{fake-telegram.ts,mailpit.ts,stack.ts,demo.ts}`
- Create: `apps/e2e/tests/user-journey.spec.ts`, `apps/e2e/tests/admin-journey.spec.ts`, `apps/e2e/tests/csp.spec.ts`
- Modify: root `package.json` (`"e2e": "pnpm --filter @oto/e2e test"`)
- Modify: `pnpm-workspace.yaml` gerekiyorsa

**Interfaces:**
- **Produces:**
  - **`stack.ts`:**
    - Derlenmiş api/worker/scheduler/demo-site/web süreçlerini başlatır.
      - Portlar: 3101 / 3100 / 4100.
      - `oto_e2e` DB: `prisma migrate reset --force` + seed (`SEED_DEMO_SOURCE=true`, `DEMO_SITE_URL=http://127.0.0.1:4100`).
      - Redis db 14.
      - `TELEGRAM_API_BASE=http://127.0.0.1:4200`.
      - `MAIL_TRANSPORT=smtp` → Mailpit 1025.
      - `SCHEDULER_TICK_MS=2000`, kaynak `intervalSec` 10.
    - Hazır olma kontrolü: `/health/ready` ve web 200.
    - Teardown'da tüm süreçleri öldürür.
  - **`fake-telegram.ts`:**
    - Bot API taklidi: `getMe`, `sendMessage`, `getUpdates`, `setWebhook`.
    - Gelen mesajları bellekte tutar.
    - Test için `/__messages` ve `/__pushUpdate` uçları.
  - **`mailpit.ts`:** `GET http://127.0.0.1:8025/api/v1/messages` ile son maili bulur ve doğrulama linkini çıkarır.

- [ ] **Step 1: Senaryolar** (önce FAIL)
  - **`user-journey`** (spec §10). Yeni kullanıcı (rastgele e-posta) ile:
    1. Kayıt ol.
    2. Mailpit'ten gelen linkle e-postayı doğrula.
    3. Ayarlar'da Telegram'ı bağla: deep-link kodu sahte Telegram'a `/start <kod>` update'i olarak gönderilir; webhook yerine polling modu kullanılır.
    4. Profil oluştur: demo marka/model, `minDiscountPct` 10.
    5. Demo-site'a `/__inject` ile %25 indirimli eşleşen ilan ekle.
    6. 60 sn içinde:
       - Panelde canlı toast ve zil sayacı 1 olmalı.
       - Bildirim listesinde ilan görünmeli.
       - Sahte Telegram'a ilan başlıklı mesaj gelmiş olmalı.
       - Mesajdaki "Analizi gör" linki `/ilan/:id`'yi açmalı.
    7. Seed admin ile giriş yap. Admin'de şunlar görünmeli:
       - İşler listesinde ilgili tarama işi
       - Bildirimler listesinde kullanıcının SENT bildirimi
  - **`admin-journey`.** Seed admin ile:
    1. Kaynak detayında dry-run başlat; sonuç tablosu ≥ 1 ilan göstermeli.
    2. Bir ilanı yeniden analiz ettir; yeni analiz bildirimi gelmeli.
    3. Bir bildirimi FAILED yap. Yol: kullanıcı Telegram'ını "403 blocked" ile reddedecek şekilde sahte Telegram ayarlanır, yeni eşleşme enjekte edilir. Ardından admin'de FAILED görünmeli ve "Yeniden dene" düğmesi sonucu `retried`/`skipped` özetinde göstermeli.
    4. Ayarlar'da `minComparables` değiştir; kaydet → başarı.
    5. Demo-site'ı captcha moduna al. Kaynak engel nedeniyle duraklatılmalı ve admin genel bakışta 60 sn içinde alarm görünmeli. Sonra demo-site'ı normale al ve kaynağı etkinleştir.
  - **`csp`:** genel sayfalar + `/app` + `/admin` gezilir; `securitypolicyviolation` olayı ve konsol `error` sayısı 0 olmalı.
- [ ] **Step 2: Altyapıyı uygula; senaryoları yeşile çevir**
  - Bekleme yalnızca `expect.poll` ya da `toBeVisible({ timeout })` ile yapılır. Sabit `waitForTimeout` YOK.
- [ ] **Step 3: Doğrula**
  - `pnpm build && pnpm e2e` art arda 3 koşuda yeşil olmalı (kararsızlık kontrolü). Sonuç rapora yazılır.
  - Teardown sonrası repodan süreç kalmamalı.
- [ ] **Step 4: Commit** `test(e2e): Playwright user and admin journeys against the built stack`

---

### Task 12: CI — gizli bilgi taraması, web build, Docker build, E2E

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.gitleaks.toml`

**Interfaces:**
- **Produces:** CI işleri:
  - **`secrets`:** gitleaks-action, `fetch-depth: 0`.
    - Allowlist yalnızca `pnpm-lock.yaml` integrity hash'leri ve `.env.example` yer tutucuları için.
    - Gerçek test fixture'ları allowlist'e EKLENMEZ.
  - **`test`:** mevcut adımlar + `pnpm --filter @oto/web build`.
  - **`docker`:** `sh scripts/docker-build-check.sh`. Push to main + PR, cache: `docker/build-push-action` gha.
  - **`e2e`:** yalnızca push to main ve `workflow_dispatch`.
    - Services: `postgres:16-alpine`, `redis:7-alpine`, `axllent/mailpit`.
    - Adımlar: `pnpm build` → `npx playwright install --with-deps chromium` → `pnpm e2e`.
    - Başarısızlıkta `playwright-report` artifact olarak yüklenir.

- [ ] **Step 1: Gitleaks'i yerelde doğrula**
  - `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 git /repo --config /repo/.gitleaks.toml` çalıştırılır.
  - Yalnızca geçmişteki sahte Telegram örnek token'ını (Plan 07 commit'leri) bulmalı.
  - Bu bulgu `.gitleaks.toml` içinde **commit hash'iyle** allowlist'e alınır, gerekçe yorumu yazılır: "Telegram dokümantasyon örneği, gerçek değil; 238b7a7 ile kaldırıldı".
  - Sonrasında tarama temiz.
- [ ] **Step 2: Workflow'u yaz**
  - `act` yoksa YAML `actionlint` ile doğrulanır: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.4`.
- [ ] **Step 3: Commit** `ci: secret scanning, web build, docker build check and Playwright e2e job`

---

### Task 13: Operasyon dokümanları, yol haritası, son doğrulama

**Files:**
- Create:
  - `docs/operations/deploy.md`: sunucu gereksinimleri, `.env.prod` hazırlığı, `keys:gen` (Git Bash/Windows notu), ilk kurulum, güncelleme ve rollback, ölçekleme (`WORKER_REPLICAS`, tek scheduler), `connection_limit` hesabı.
  - `docs/operations/backup-restore.md`: zamanlama, rotasyon, S3, aylık restore testi, manuel geri yükleme adımları.
  - `docs/operations/alarms.md`: alarm anahtarları ve eşikleri, müdahale runbook'u. `docs/admin.md`'den bağlantı verilir.
  - `docs/operations/telegram-bot.md`: BotFather, webhook kurulumu (`pnpm telegram:webhook set`), secret rotasyonu (yeni secret → env → restart → `set`), polling/webhook geçişi, token'ın api VE worker'da gerekli olduğu.
  - `docs/operations/security.md`:
    - CSP ve HSTS
    - Gizli bilgi politikası, gitleaks, "token biçimli literal yok" kuralı
    - `DATA_ENCRYPTION_KEY` rotasyonu (`v1:` biçimi, yeniden şifreleme adımları)
    - Saklama süreleri
    - KVKK
- Modify:
  - `README.md`: hızlı kurulum dev + prod bağlantıları
  - `docs/architecture.md`: dağıtım diyagramı
  - `.env.example`
  - Yol haritası:
    - Plan 08 tamamlandı olarak işaretlenir.
    - Admin 2FA "Plan dışı"na taşınır.
    - Kalan borçlar "Plan 08 sonrası" bölümüne yazılır: klon yeniden yayın emsal dışlama, explanation boyutu, ölçek maddeleri, bildirim gruplama, ödeme.

- [ ] **Step 1: Dokümanları yaz**
- [ ] **Step 2: Tam doğrulama** — sırayla çalıştırılır:
  - `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build && pnpm e2e`
  - `sh scripts/docker-build-check.sh`
  - `sh scripts/prod-smoke.sh`
  - `sh scripts/backup-restore-check.sh`
  - gitleaks
  - Her birinin sayıları ve süresi rapora yazılır.
- [ ] **Step 3: Temizlik** — ayağa kalkan bütün süreç ve konteynerler durdurulur, ardından kontrol edilir:
  - Port 3000/3001/3100/3101/4000/4100/4200/8443 boş.
  - `docker ps` içinde smoke projesi yok.
- [ ] **Step 4: Commit** `docs: operations guides (deploy, backup/restore, alarms, Telegram, security); roadmap`
