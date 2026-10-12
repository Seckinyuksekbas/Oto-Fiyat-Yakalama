# Oto-Fiyat-Yakalama

Otomobil ilanlarını merkezi olarak toplayan, kural tabanlı ve açıklanabilir fiyat analiziyle piyasa altı fırsatları tespit eden, kullanıcıların arama profillerine göre panel içi ve Telegram bildirimleri gönderen çok kullanıcılı platform.

- Tasarım: [`docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`](docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md)
- Yol haritası: [`docs/superpowers/plans/2026-10-10-00-roadmap.md`](docs/superpowers/plans/2026-10-10-00-roadmap.md)
- Mimari: [`docs/architecture.md`](docs/architecture.md)

## Gereksinimler
Node 22+, Docker Desktop (çalışır durumda), `corepack enable`. Windows'ta komutları **Git Bash**'te çalıştırın: PowerShell 5.1'de `>>` UTF-16 yazar ve `.env` dosyasını bozar.

## Hızlı başlangıç (geliştirme)
```bash
pnpm install
cp .env.example .env
pnpm -s keys:gen >> .env         # JWT anahtarları + veri şifreleme anahtarı
pnpm db:up                     # Postgres, Redis, Mailpit
pnpm build:packages
pnpm db:migrate && pnpm db:seed
pnpm dev:api                   # http://localhost:3001/api/v1/health/ready
```
Mailpit arayüzü: http://localhost:8025

Diğer yerel yığınlarla port çakışmasını önlemek için dev compose varsayılan olmayan host portları kullanır: Postgres `localhost:5433`, Redis `localhost:6380` (`.env.example` bunlara göre ayarlıdır). Mailpit: SMTP `1025`, arayüz `8025`.

## Toplama hattını çalıştırma (geliştirme)
```bash
pnpm db:up && pnpm build:packages && pnpm db:migrate
pnpm db:seed                   # SEED_DEMO_SOURCE=true ise demo kaynağı da kaydeder
pnpm dev:demo                  # http://localhost:4000/ilanlar — sahte ilan sitesi
pnpm dev:scheduler             # zamanı gelen kaynak için tarama işi üretir
pnpm dev:worker                # tarama işlerini yürütür
```
Demo sitesinin kontrol uç noktaları: `POST /__tick` (piyasayı ilerlet), `POST /__inject` (ilan ekle, ör. `{"discount":0.25}`), `POST /__patch/:id`, `POST /__mode` (`normal|broken|captcha|forbidden`), `POST /__reset`.

Worker aynı süreçte analiz kuyruğunu da tüketir; analiz sonuçları `ListingAnalysis` tablosuna yazılır. Motorun kuralları: [`docs/analysis-engine.md`](docs/analysis-engine.md).

Worker ayrıca `match` kuyruğunu tüketir: analiz olayları kullanıcıların arama profilleriyle eşleştirilir ve `ListingMatch` yazılır. Paralellik `MATCH_CONCURRENCY` (varsayılan 4) ile ayarlanır. Ayrıntılar: [`docs/matching.md`](docs/matching.md).

**Veritabanı havuzu (`connection_limit`):** her süreç `DATABASE_URL`'deki `?connection_limit=N` kadar bağlantı açar. Worker için en az `SCRAPE + ANALYZE + MATCH + NOTIFY_CONCURRENCY + 5 (notify-telegram) + 3` gerekir, varsayılanlarla 26. Scheduler (`ROLE=scheduler`) için en az 3 gerekir. Production'da değer eksik ya da düşükse süreç başlamaz; geliştirmede yalnızca uyarır. Production compose varsayılanları worker 30, scheduler 5, api 10'dur. Toplamları Postgres `max_connections` sınırının altında kalmalıdır: `api + WORKER_REPLICAS × worker + scheduler + ~10 < POSTGRES_MAX_CONNECTIONS` (varsayılan 150). Bkz. [`docs/operations/deploy.md`](docs/operations/deploy.md#connection_limit-hesabı).

## Bildirimler
Eşleşen her ilan için `Notification` kaydı yazılır; worker `notify` / `notify-telegram` kuyruklarını tüketir (uygulama içi + SSE, Telegram). Akış, SSE sözleşmesi ve Telegram kurulumu: [`docs/notifications.md`](docs/notifications.md).

| Değişken | Süreç | Açıklama |
|---|---|---|
| `NOTIFY_CONCURRENCY` | worker | `notify` kuyruğu paralelliği (varsayılan 8, 1-32); `notify-telegram` sabit 5 paralel + 25 iş/sn limiter |
| `TELEGRAM_BOT_TOKEN` | api, worker | BotFather token'ı. Yoksa bağlama 503 döner ve TELEGRAM bildirimi planlanmaz. Production worker'ı token yoksa açılışta uyarır ve `SystemLog` WARN satırı yazar. Kurulum ve webhook: [`docs/operations/telegram-bot.md`](docs/operations/telegram-bot.md) |
| `TELEGRAM_BOT_USERNAME` | api | Bağlama deep link'i için bot kullanıcı adı (token varken zorunlu) |
| `TELEGRAM_MODE` | api | `polling` (geliştirme, varsayılan) veya `webhook` (üretim) |
| `TELEGRAM_WEBHOOK_SECRET` | api | Webhook modunda zorunlu; 32-256 karakter `[A-Za-z0-9_-]`; `setWebhook` `secret_token` ile aynı |
| `TELEGRAM_API_BASE` | api, worker | Bot API adresi (varsayılan `https://api.telegram.org`; testlerde sahte API) |
| `PUBLIC_BASE_URL` | api, worker | Worker'da "Analizi gör" düğmesi için; production'da açıkça ayarlanmalı ve localhost olamaz |

## Testler
```bash
pnpm lint && pnpm typecheck
pnpm test        # birim testleri
pnpm test:e2e    # Testcontainers ile Postgres + Redis (Docker gerekir)
pnpm e2e         # Playwright uçtan uca senaryolar (derlenmiş süreçler; bkz. apps/e2e/README.md)
```

## Production
Tek sunucu, Docker Compose (Caddy + web + api + worker + scheduler + Postgres + Redis + gece yedeği):
```bash
cp .env.prod.example .env.prod && chmod 600 .env.prod    # yer tutucuları doldurun
env -i HOME="$HOME" PATH="$PATH" docker compose --env-file .env.prod up -d --build --wait
```
Operasyon dokümanları:
- [`docs/operations/deploy.md`](docs/operations/deploy.md): sunucu gereksinimleri, `.env.prod`, ilk kurulum, güncelleme/geri dönüş, ölçekleme ve bağlantı bütçesi
- [`docs/operations/backup-restore.md`](docs/operations/backup-restore.md): gece yedeği, rotasyon, sunucu dışı kopya, aylık geri yükleme testi, geri yükleme prosedürü
- [`docs/operations/alarms.md`](docs/operations/alarms.md): alarm anahtarları, eşikler, müdahale
- [`docs/operations/telegram-bot.md`](docs/operations/telegram-bot.md): BotFather, webhook (`pnpm telegram:webhook set|info|delete`), secret/token rotasyonu
- [`docs/operations/security.md`](docs/operations/security.md): CSP/HSTS, gizli bilgi politikası ve gitleaks, production env kuralları, anahtar rotasyonu, saklama süreleri, KVKK

Yerel doğrulama: `sh scripts/docker-build-check.sh`, `sh scripts/prod-smoke.sh`, `sh scripts/backup-restore-check.sh`.

## Web uygulaması (kullanıcı paneli)
```bash
PUBLIC_BASE_URL=http://localhost:3000 pnpm dev:api   # API :3001
pnpm dev:web                                          # http://localhost:3000
```
Next.js 15 tabanlı "Gece Showroom" arayüzü; `/api/*` istekleri `API_ORIGIN` (varsayılan `http://localhost:3001`, build zamanında sabitlenir) adresine yönlendirilir. Rotalar, oturum yenileme modeli, SSE istemci kuralları ve tasarım tokenları: [`docs/web.md`](docs/web.md). Görsel smoke: `node apps/web/scripts/screenshots.mjs` (Playwright; ilk kez `pnpm --filter @oto/web exec playwright install chromium`).

## Yönetim paneli (admin)
`http://localhost:3000/admin` — seed süper admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) ile giriş yapın. Kullanıcılar ve abonelikler, ilanlar/analizler (yeniden analiz), veri kaynakları (dry-run test taraması, etkinleştirme/duraklatma), işler, proxy'ler, kuyruklar, worker'lar, bildirimler (yeniden deneme, gecikme p50/p95), paketler, sistem ayarları, denetim ve sistem logları, canlı alarmlar. Yetki matrisi, denetim kuralları, alarmlar ve SSRF kuralları: [`docs/admin.md`](docs/admin.md).

| Değişken | Süreç | Açıklama |
|---|---|---|
| `PROXY_CHECK_URL` | api | Proxy sağlık kontrolü hedefi (varsayılan `https://www.gstatic.com/generate_204`) |
| `MONITOR_INTERVAL_MS` | worker (scheduler) | Alarm monitörünün en kısa çalışma aralığı (varsayılan 60000) |
