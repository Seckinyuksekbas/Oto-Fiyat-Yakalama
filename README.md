# Oto-Fiyat-Yakalama

Otomobil ilanlarını merkezi olarak toplayan, kural tabanlı ve açıklanabilir fiyat analiziyle piyasa altı fırsatları tespit eden, kullanıcıların arama profillerine göre panel içi ve Telegram bildirimleri gönderen çok kullanıcılı platform.

- Tasarım: [`docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`](docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md)
- Yol haritası: [`docs/superpowers/plans/2026-10-10-00-roadmap.md`](docs/superpowers/plans/2026-10-10-00-roadmap.md)
- Mimari: [`docs/architecture.md`](docs/architecture.md)

## Gereksinimler
Node 22+, Docker Desktop (çalışır durumda), `corepack enable`.

## Hızlı başlangıç
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

Worker ayrıca `match` kuyruğunu tüketir: analiz olayları kullanıcıların arama profilleriyle eşleştirilir ve `ListingMatch` yazılır. Paralellik `MATCH_CONCURRENCY` (varsayılan 4) ile ayarlanır; `DATABASE_URL` `connection_limit` değeri `SCRAPE_CONCURRENCY + ANALYZE_CONCURRENCY + MATCH_CONCURRENCY` toplamından büyük olmalıdır. Ayrıntılar: [`docs/matching.md`](docs/matching.md).

## Bildirimler
Eşleşen her ilan için `Notification` kaydı yazılır; worker `notify` / `notify-telegram` kuyruklarını tüketir (uygulama içi + SSE, Telegram). Akış, SSE sözleşmesi ve Telegram kurulumu: [`docs/notifications.md`](docs/notifications.md).

| Değişken | Süreç | Açıklama |
|---|---|---|
| `NOTIFY_CONCURRENCY` | worker | `notify` kuyruğu paralelliği (varsayılan 8, 1-32); `notify-telegram` sabit 5 paralel + 25 iş/sn limiter |
| `TELEGRAM_BOT_TOKEN` | api, worker | BotFather token'ı. Yoksa bağlama 503 döner, TELEGRAM bildirimi planlanmaz |
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
```

## Web uygulaması (kullanıcı paneli)
```bash
PUBLIC_BASE_URL=http://localhost:3000 pnpm dev:api   # API :3001
pnpm dev:web                                          # http://localhost:3000
```
Next.js 15 tabanlı "Gece Showroom" arayüzü; `/api/*` istekleri `API_ORIGIN` (varsayılan `http://localhost:3001`, build zamanında sabitlenir) adresine yönlendirilir. Rotalar, oturum yenileme modeli, SSE istemci kuralları ve tasarım tokenları: [`docs/web.md`](docs/web.md). Görsel smoke: `node apps/web/scripts/screenshots.mjs` (Playwright; ilk kez `pnpm --filter @oto/web exec playwright install chromium`).
