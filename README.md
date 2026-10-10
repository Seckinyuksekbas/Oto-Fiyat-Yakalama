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

## Testler
```bash
pnpm lint && pnpm typecheck
pnpm test        # birim testleri
pnpm test:e2e    # Testcontainers ile Postgres + Redis (Docker gerekir)
```
