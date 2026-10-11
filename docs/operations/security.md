# Güvenlik

Kimlik doğrulama modeli için [docs/architecture.md](../architecture.md#kimlik-doğrulama), SSRF ve admin kuralları için [docs/admin.md](../admin.md#ssrf-kuralları), CSP ayrıntıları için [docs/web.md](../web.md) dokümanına bakın. Bu doküman production'da uyulacak kuralları ve operasyon prosedürlerini toplar.

## CSP ve güvenlik başlıkları

- **CSP (nonce yolu):** `apps/web/src/middleware.ts` her sayfa isteğinde 128 bit bir nonce üretir. CSP'yi hem yanıta hem istek başlığına yazar ve kök layout'a `x-nonce` verir. Next kendi satır içi betiklerine bu nonce'u koyar. Bunun bedeli şudur: **tüm sayfalar dinamik render edilir**, statik ön render ve ISR yoktur. Hash'li statik CSP denendi ama Next'in `self.__next_f.push` betikleri engellendi.
  ```
  default-src 'self'; script-src 'self' 'nonce-<istek>' 'sha256-<tema betiği>'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https: [+ CSP_IMG_EXTRA]; font-src 'self'; connect-src 'self';
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
  ```
  - `script-src` içine `'unsafe-inline'` **asla** girmez. Geliştirmede yalnızca `'unsafe-eval'` ve `img-src http:` eklenir.
  - `img-src https:`: ilan fotoğrafları kaynak sitelerin mutlak URL'leridir, bu yüzden https görsellere genel izin verilir. Yalnızca http üzerinden sunulan görsel origin'leri için `CSP_IMG_EXTRA` (boşlukla ayrılmış http(s) origin listesi, çalışma zamanında okunur) kullanılır. Geçersiz bir değerde web açılmaz.
  - `/api/*`, `_next/static`, `_next/image` ve `favicon.ico` middleware dışındadır.
- **Diğer başlıklar:** `next.config.ts` şunları ekler: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` ve `Permissions-Policy: camera=(), microphone=(), geolocation=()`. `X-Powered-By` kapalıdır. api tarafında `helmet` kullanılır.
- **HSTS** Caddy'de verilir: `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Yalnızca HTTPS sitesinde gönderilir. `includeSubDomains` nedeniyle alan adının **tüm alt alan adları** HTTPS sunmalıdır. Bu ayar bir yıl boyunca geri alınamaz, bu yüzden alan adını buna göre seçin. Caddy `Server` ve `X-Powered-By` başlıklarını siler.
- **İstemci IP'si:** Caddy en dış halkadır ve upstream'e gerçek istemci adresini yazar. api `TRUST_PROXY=1` ile yalnızca bu tek halkaya güvenir. Giriş kilidi ve throttle IP'leri bu adrese dayanır. Önüne bir CDN konursa bkz. [deploy.md](deploy.md#caddy).

## Gizli bilgi politikası

- Gerçek token, anahtar ya da parola **repoya girmez.** Bu değerler yalnızca gitignore'lu `.env` ve `.env.prod` dosyalarında (`chmod 600`) durur. `.env.example` ve `.env.prod.example` yalnızca yer tutucu içerir.
- **Token biçimli literal yasağı:** testlerde, dokümanlarda ve fixture'larda gerçek görünümlü token yazılmaz. Gerekli değerler çalışma anında üretilir. Örnek: `['123456789', 'TEST'.padEnd(35, 'x')].join(':')`. Scriptler (`prod-smoke.sh`, `docker-build-check.sh`, `backup-restore-check.sh`, `screenshots.mjs`) parola ve anahtarlarını her çalıştırmada üretir (`gen-keys.mjs`, `openssl rand`) ve çıkışta siler.
- Sırlar **build argümanı olarak verilmez**, yalnızca runtime env ile gelir. Compose her servise yalnızca ihtiyacı olan değişkenleri aktarır:
  - web hiçbir sır almaz.
  - worker JWT özel anahtarını görmez.
  - scheduler Telegram token'ını görmez.
- Loglar ve hata mesajları değer yazdırmaz. Env hataları yalnızca değişken adını ve nedeni söyler. Hata metinleri kalıcılaştırılmadan önce `redactSecrets` ile maskelenir (URL kullanıcı bilgisi, sorgu dizileri, `bot<token>`). Telegram scripti token biçimli her değeri maskeler.
- `docker compose config` ve `docker inspect` çıktıları sır içerir, bu çıktıları paylaşmayın ([deploy.md](deploy.md#kabuk-hijyeni-ve-sır-ifşası)).

### gitleaks

- CI'daki `secrets` işi `gitleaks/gitleaks-action@v2` ile tüm geçmişi tarar. Yapılandırma `.gitleaks.toml` dosyasındadır: varsayılan kural seti kullanılır, yol ya da regex allowlist'i **yoktur**.
- Yerel tarama (tüm geçmiş, değerler maskeli):
  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 git /repo \
    --config /repo/.gitleaks.toml --redact
  ```
- **`.gitleaksignore` yalnızca parmak izi içerir** (`commit:dosya:kural:satır`). Bir satır ancak bulgu incelenip gerçek olmadığı doğrulandıktan sonra, gerekçe yorumuyla eklenir. Dosya yolu ya da kural bazında toptan muafiyet **eklenmez.** Yeni bir test fixture'ı bulgu üretiyorsa onu muaf tutmayın, fixture'ı çalışma anında üretime çevirin.
- **Gerçek bir sır commit'lendiyse** önce sırrı **hemen döndürün** (yeni değer üretin, eskisini iptal edin). Geçmişten silmek tek başına yetmez, çünkü değer klonlarda ve CI loglarında kalmış olabilir.

## Production env kuralları

`NODE_ENV=production` iken süreçler açılışta env'i doğrular. Bir kural ihlal edilirse süreç başlamaz ve mesaj `Invalid environment: <VAR>: <neden>` biçimindedir (değer yazdırılmaz).

| Süreç | Kural |
|---|---|
| api | `COOKIE_SECURE=true` |
| api | `PUBLIC_BASE_URL` https olmalı, localhost/loopback olamaz |
| api | `MAIL_TRANSPORT=smtp`. `SMTP_HOST` loopback olamaz. `SMTP_PORT` açıkça verilmeli ve 1025 olamaz. `SMTP_FROM` alan adı loopback olamaz |
| api | 587 portu `SMTP_SECURE=false`, 465 portu `SMTP_SECURE=true` ister. `SMTP_USER`/`SMTP_PASS` birlikte verilir. Kimlik bilgisi varsa TLS zorunludur (`SMTP_SECURE` ya da `SMTP_REQUIRE_TLS`). `SMTP_REQUIRE_TLS` varsayılanı true'dur |
| api | `HIBP_ENABLED` varsayılanı true'dur (kapatmak için açıkça `false` yazılır) |
| api | `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` Ed25519 olmalı. Açılışta test payload'ı imzalanıp doğrulanır (self-test); çift uyuşmazsa api başlamaz |
| api | Token varsa `TELEGRAM_MODE=webhook` (+ secret) ve https `TELEGRAM_API_BASE` zorunludur |
| api | `TRUST_PROXY` 0–5 aralığında olmalı (compose'da 1) |
| worker / scheduler | `PUBLIC_BASE_URL` ve `BOT_CONTACT_URL` açıkça verilmeli ve loopback olamaz. `TELEGRAM_API_BASE` https olmalı |
| worker / scheduler | `DATABASE_URL` içinde yeterli `connection_limit` olmalı ([deploy.md](deploy.md#connection_limit-hesabı)). `SHUTDOWN_TIMEOUT_MS` ≤ 38000 |
| worker | `TELEGRAM_BOT_TOKEN` yoksa süreç **açılır**, ama `warn` logu ve bir `SystemLog` WARN satırı (`telegram`) yazar |
| web | `API_ORIGIN` geçerli bir http(s) URL olmalı ve derleme anındaki değerle aynı olmalı. `CSP_IMG_EXTRA` geçerli olmalı |
| seed (migrate) | `SEED_DEMO_SOURCE=true` reddedilir. `SEED_ADMIN_PASSWORD` en az 12 karakter olmalı ve `<`/`>` içeremez |
| demo-site | production'da başlamayı reddeder |

## Oturum ve kötüye kullanım korumaları

- **Access** token EdDSA JWT'dir ve ömrü 15 dk'dır. **Refresh** token opaktır, ömrü 30 gündür ve her kullanımda döner. Yeniden kullanım tespiti aileyi iptal eder.
- **Mutlak aile ömrü 90 gündür** (`Session.familyStartedAt`). Rotasyon bu tarihi taşır. 90 günü aşan bir aile ile yapılan refresh 401 döner, aile iptal edilir ve kullanıcı yeniden giriş yapar.
- **Giriş kilidi:** IP+e-posta başına 15 dk içinde 5 hata. Throttle: genel 120/dk, `/auth` 10/dk.
- **Şifremi unuttum bekleme süresi:** e-posta başına 60 sn (Redis `NX`). Bekleme sırasında da yanıt 204 olur, böylece hesap varlığı sızmaz. Redis yoksa istek yine işlenir (fail-open).
- **Kilit zaman aşımları:** advisory/satır kilidi tutan transaction'larda `lock_timeout` 5 sn ve `statement_timeout` 12 sn (ağır işlemlerde 25 sn) kullanılır. Prisma tx: `maxWait` 10 sn, `timeout` 15 sn. Bu süreler aşılırsa ya da Postgres bir deadlock (`40P01`, Prisma `P2034`) veya serileştirme çakışması (`40001`) bildirirse yanıt **503 `SERVICE_BUSY`** ve `Retry-After: 5` olur. Böylece bekleyen istekler sınırsız asılı kalmaz. Sık görülüyorsa veritabanı yükünü ve bağlantı bütçesini inceleyin.
- **Kaynak `config` gizli anahtarları** admin yanıtlarında ve denetim kaydının `before`/`after` alanlarında `"***"` olarak döner. Kural **ad parçası (segment) tabanlıdır**: `token`, `secret`, `pass(word)`, `auth`, `apiKey`, `credential` gibi parçalar gizlidir. Ad yalnızca `key` ise ya da `api|private|secret|access` + `key` biçimindeyse de gizlidir. Alt dize eşleşmesi yapılmaz; örneğin `keywords`, `authorName` ve `sortKey` gizli değildir. Gizli bir anahtarın tüm torunları maskelenir. Ayrıntılar: [admin.md](../admin.md#kaynak-yaşam-döngüsü).
- Telegram sohbet kimlikleri (`NotificationChannel.config`) ve proxy URL'leri (`ProxyConfig.urlEncrypted`) AES-256-GCM ile şifreli saklanır.

## `DATA_ENCRYPTION_KEY` rotasyonu

Şifreli değerler `v1:<iv>:<tag>:<ciphertext>` (base64url) biçimindedir. Sürüm öneki gelecekte birden fazla anahtarı destekleyecek biçimde tasarlanmıştır. **Bugün kod yalnızca `v1` sürümünü ve tek bir anahtarı tanır**: `Encryptor.decrypt` başka bir önek gördüğünde ya da anahtar uyuşmadığında hata verir. Repoda hazır bir yeniden şifreleme scripti **yoktur**. Bu iş Plan 08 sonrası borç olarak kayıtlıdır.

Anahtar sızdıysa ya da politika gereği değişmesi gerekiyorsa iki yol vardır:

**A) Yeniden şifreleme (veri korunur).** Kısa bir bakım penceresi gerekir:
1. Elle yedek alın ([backup-restore.md](backup-restore.md)) ve yeni anahtarı üretin: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Yazanları durdurun: `dc stop api worker scheduler`.
3. Tek seferlik bir script iki sütunu **tek transaction'da** yeniden şifreler: `NotificationChannel.config` (TELEGRAM satırları) ve `ProxyConfig.urlEncrypted`. Script her satırı eski anahtarla `Encryptor.decrypt`, yeni anahtarla `encrypt` eder. `@oto/server-common` içindeki `Encryptor` kullanılabilir. Anahtarlar scripte yalnızca env ile verilir, komut satırına yazılmaz. Herhangi bir satır çözülemezse işlem tümüyle geri alınır.
4. `.env.prod` içinde `DATA_ENCRYPTION_KEY` değerini yeni anahtarla değiştirin ve `dc up -d --wait` çalıştırın.
5. Bir Telegram test bildirimi gönderip doğrulayın ve proxy listesini açın. Eski anahtarı güvenli biçimde imha edin. Yeni anahtarı parola kasasına koyun.

**B) Acil durum (veri kaybı kabul edilir):** anahtarı değiştirin. Ardından Telegram kanallarını silin (kullanıcılar yeniden bağlar) ve proxy URL'lerini admin panelinden yeniden girin. Eski anahtarla şifrelenmiş satırlar okunamaz. Worker bu satırlarda `CHANNEL_CONFIG_INVALID` ile kalıcı hata verir.

Unutmayın: eski yedekler eski anahtarla şifrelenmiş değer içerir. Eski bir yedeği geri yüklemek o yedeğin anahtarını gerektirir.

## Saklama süreleri

Lider scheduler günde bir kez çalışır (24 saatte bir ve liderlik alındığında). Silme 5000'lik batch'lerle yapılır. Bir tablodaki hata diğer tabloları durdurmaz. Sonuç (tablo → silinen satır) `info` loguna yazılır.

| Tablo | Silinen |
|---|---|
| `SystemLog`, `ScrapeError`, `ListingIssue` | `createdAt` 30 günden eski |
| `AuditLog` | 365 günden eski |
| `Notification` | `createdAt` 90 günden eski. Eşleşmeye dokunulmaz: FK bildirimden eşleşmeye doğrudur |
| `Session` | süresi 30 günden önce dolmuş ya da 30 günden önce iptal edilmiş |
| `EmailVerificationToken`, `PasswordResetToken`, `TelegramLinkToken` | 7 günden önce kullanılmış ya da süresi dolmuş |
| `ListingAnalysis` | 90 günden eski olanlar; **ancak** aşağıdakiler hariç |

`ListingAnalysis` için korunan satırlar:

- `Listing.latestAnalysisId` olan analiz.
- **Herhangi bir `ListingMatch` tarafından referanslanan** analiz.
- Eşleştirme kuyruğuna hiç gönderilememiş analiz (`matchEvent` dolu, `matchQueuedAt` boş).
- İlanın **ilk** analizi.

`ListingMatch.analysisId` FK'si `ON DELETE NO ACTION`'dır. Eşzamanlı bir yarışta bile analiz silinmesi eşleşmeyi cascade ile silemez ve `NEW` bildirimi yeniden tetiklenemez. Silme hata verir ve satır korunur.

BullMQ: başarısız bildirim işleri 7 gün saklanır (admin yeniden denemesi için). Yedekler 7 gün (günlük) ve 4 hafta (haftalık) saklanır; sunucu dışı kopyanın süresini kova kuralı belirler.

## KVKK

- **İşlenen kişisel veriler:**
  - e-posta ve ad
  - parola özeti (argon2)
  - oturum kayıtları (IP, User-Agent)
  - denetim kayıtlarında aktör IP'si
  - arama profilleri, favoriler ve bildirimler
  - Telegram sohbet kimliği (şifreli; aramalar için yalnızca SHA-256 özeti tutulur)
- İlan verileri kaynak sitelerin kamuya açık ilanlarıdır. Kişisel iletişim bilgisi toplanmaz.
- **Silme hakkı:** kullanıcı `DELETE /api/v1/me` ile, admin ise kullanıcı silme ile hesabı anonimleştirir. Bu işlem şunları yapar:
  - Profiller, kanallar, favoriler, oturumlar ve token'lar silinir.
  - Bekleyen bildirimler `FAILED (USER_INACTIVE)` olur.
  - Kullanıcıyı hedefleyen denetim kayıtlarının `before`/`after` alanları `{ redacted: true }` olur.
  - E-posta `deleted+<id>@invalid.local` olur, parola özeti silinir, durum `DELETED` olur.
  - Son aktif süper admin silinemez.
- **Yedekler:** anonimleştirilmiş bir kullanıcının eski hali yedeklerde rotasyon süresi boyunca kalır. Yerelde bu süre en fazla yaklaşık 4 haftadır; sunucu dışı kopyada süreyi kova kuralı belirler. Bir yedek geri yüklenirse, yedek tarihinden sonra yapılmış silme taleplerini yeniden uygulamanız gerekir. Bunun için geri yüklemeden **önce** (mümkünse) mevcut veritabanından `status = 'DELETED'` kullanıcı kimliklerini dışa alın. Geri yüklemeden sonra bu kullanıcıları admin panelinden yeniden silin. Admin silmeleri denetim kaydında `user.delete` olarak görünür, ama kullanıcının kendi silmesi (`DELETE /me`) denetim kaydına **yazılmaz**.
- Saklama süreleri yukarıdaki tablodadır. Bildirimlerin 90 günde silinmesi KVKK gereğidir.

## Bilinen sınırlar

- **Proxy tarafında DNS rebinding:** proxy üzerinden yapılan isteklerde hedef adı proxy çözer. `guardedLookup` yalnız proxy'nin kendi adresini denetleyebilir. Admin tarafından girilen proxy'lerin güvenilir olması gerekir ([admin.md](../admin.md#ssrf-kuralları)).
- **E2E `NODE_ENV=development` ile çalışır.** Playwright yığını (`apps/e2e`) derlenmiş süreçleri development modunda başlatır, çünkü production env kuralları localhost'u reddeder. Production kuralları ayrıca birim testleri, `docker-build-check.sh` ve `prod-smoke.sh` tarafından doğrulanır.
- **Admin 2FA yoktur** (spec §6 "Ertelenenler"). Admin hesaplarında güçlü ve benzersiz parola kullanın, gereksiz admin hesabı açmayın.
- Teslim garantisi en az bir kezdir. Nadiren aynı bildirim iki kez gidebilir.
