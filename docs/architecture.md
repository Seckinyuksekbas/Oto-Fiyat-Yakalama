# Mimari (Plan 01 sonrası durum)

Ayrıntılı tasarım: `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`.

## Paketler
- `packages/shared` — zod şemaları (API sözleşmesi), hata kodları, plan limit tipi, zaman yardımcıları. Frontend de aynı şemaları kullanır.
- `packages/db` — Prisma şeması (tüm platform modelleri), migration'lar, seed (`FREE/PRO/BUSINESS` planları, ilk süper admin).
- `apps/api` — NestJS 11 REST API, `/api/v1`.

## İstek yaşam döngüsü (apps/api)
1. `helmet` → `cookie-parser` → JSON gövde (100 kb, hatalar standart formatta) → pino-http (`x-request-id`).
2. Global guard sırası: **CsrfGuard** (mutasyonlarda `X-Requested-With` + Origin) → **JwtAuthGuard** (`access_token` cookie; `@Public()` yoksa zorunlu) → **RolesGuard** (`@Roles` varsa oturum/kullanıcı/rol DB'den canlı) → **AppThrottlerGuard** (Redis; 120/dk, `/auth` 10/dk).
3. Handler → (`@Audited` ise) **AuditInterceptor** `AuditLog` yazar → **AllExceptionsFilter** tüm hataları `{ error: { code, message, details? } }` biçimine çevirir.

## Kimlik doğrulama
- Access: EdDSA JWT, 15 dk. Refresh: opak token, 30 gün, DB'de SHA-256; her kullanımda döner. Eski token 10 sn içinde gelirse `REFRESH_RACE` (aile korunur), sonra gelirse `REFRESH_REUSED` (aile iptal + güvenlik bildirimi + audit).
- Giriş kilidi: IP+e-posta başına 15 dk'da 5 hata (Redis).
- Askıya alma / şifre değişimi / sıfırlama oturumları iptal eder. Admin uç noktaları ayrıca DB'den canlı doğrular.

## İzolasyon
- `/me` altındaki veri erişimi yalnızca `*.repository.ts` üzerinden ve `userId` ile yapılır (ESLint kuralı).
- `test/isolation.e2e.spec.ts`: her `/me` route'u için A/B senaryosu; eksik senaryo testi düşürür.
- `test/audit-coverage.e2e.spec.ts`: her `/admin` route'u rol ister, her admin mutasyonu `@Audited`'dır.
