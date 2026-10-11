# Dağıtım (production, tek sunucu)

Production yığını `docker-compose.yml` ile tek sunucuda çalışır. Env şablonu `.env.prod.example` dosyasındadır. Yedekler için [backup-restore.md](backup-restore.md), Telegram için [telegram-bot.md](telegram-bot.md), güvenlik kuralları için [security.md](security.md), alarmlar için [alarms.md](alarms.md) dokümanına bakın. Mimari diyagram: [../architecture.md](../architecture.md#dağıtım-plan-08).

## Topoloji

| Servis | İmaj | Ağ | Not |
|---|---|---|---|
| `caddy` | `caddy:2.10.2-alpine` | edge | Dışa açılan tek servis (80/443, HTTP/3). TLS otomatik, HSTS, `/api/*` → api, gerisi → web |
| `web` | `oto/web` | edge | Next.js standalone. Hiçbir sır almaz |
| `api` | `oto/api` | edge, backend | NestJS. `TRUST_PROXY=1` (tek vekil: Caddy) |
| `worker` | `oto/worker` | backend, egress | Kuyruk tüketicisi. `WORKER_REPLICAS` (varsayılan 2) |
| `scheduler` | `oto/worker` (`--role=scheduler`) | backend, egress | Daima 1 örnek |
| `migrate` | `oto/migrate` | backend | Tek seferlik `prisma migrate deploy` (+ isteğe bağlı seed). api/worker/scheduler bunun başarıyla bitmesini bekler |
| `postgres` | `postgres:16-alpine` | backend | `max_connections=${POSTGRES_MAX_CONNECTIONS:-150}` |
| `redis` | `redis:7-alpine` | backend | AOF (`everysec`), `noeviction`, parola yapılandırma dosyasında |
| `backup` | `oto/backup` | backend | Gece `pg_dump` + rotasyon ([backup-restore.md](backup-restore.md)) |

`backend` ağı `internal`'dır: postgres ve redis dışarıya çıkamaz, dışarıdan da erişilemez. Dışa çıkış iki ağdan yapılır:

- `edge` (internal **değil**): Caddy gelen trafiği buradan api ve web'e iletir. api dışa çıkışını da bu ağdan yapar: SMTP, HIBP parola kontrolü, Telegram (bağlama, webhook kurulumu) ve admin proxy testi. Bu yüzden `edge` ağını `internal` yapmayın, aksi halde bu özellikler bozulur. web de `edge` üzerindedir ama dışa çıkış ihtiyacı yoktur, yalnızca Caddy'den gelen istekleri karşılar.
- `egress`: worker ve scheduler dış kaynaklara (scraping) ve Telegram'a buradan çıkar.

## Sunucu gereksinimleri

- Linux x86_64, Docker Engine **25+** ve Compose **v2.20+**. `backup` healthcheck'indeki `start_interval` bu sürümleri gerektirir.
- Önerilen başlangıç boyutu 2 vCPU, 4 GB RAM ve 40 GB disk. Bu bir tahmindir, yükle ölçülmemiştir. İmajlar yaklaşık 0,4–0,6 GB'tır (api ~450 MB, worker ~460 MB, web ~385 MB, migrate ~600 MB). Yedekler aynı diskte durur.
- Alan adı için A/AAAA kaydı sunucuyu göstermelidir. 80 ve 443 (TCP ve UDP) açık olmalıdır, çünkü Let's Encrypt HTTP-01/TLS-ALPN doğrulaması bunları ister.
- Derleme sunucuda yapılırsa ağ erişimi gerekir. `pnpm fetch` deps katmanında paketleri indirir. Sonraki adımlar (`install --offline`, `deploy --offline`) ağsız çalışır.

## `.env.prod` hazırlığı

```bash
cp .env.prod.example .env.prod && chmod 600 .env.prod   # gitignore'lu; repoya asla girmez
```

- Her `[zorunlu]` satırı doldurun. Eksik değerde compose `${VAR:?...}` ile başlamayı reddeder.
- **Parolalar yalnız `[A-Za-z0-9]` içersin.** `POSTGRES_PASSWORD` `DATABASE_URL`'ye, `REDIS_PASSWORD` ise `REDIS_URL`'ye ve Redis yapılandırmasına gömülür. Üretmek için `openssl rand -hex 24` kullanın.
- Telegram webhook secret'ı için `openssl rand -hex 32` kullanın (32–256 karakter `[A-Za-z0-9_-]`).
- **Anahtarlar (`keys:gen`):** `node scripts/gen-keys.mjs` üç satır yazar: `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` ve `DATA_ENCRYPTION_KEY`. Bu satırları `.env.prod` içindeki yer tutucuların yerine koyun. PEM'ler tek satırlık ve `\n` kaçışlıdır, çift tırnak korunmalıdır.
  - **Windows notu:** komutu **Git Bash**'te çalıştırın (`node scripts/gen-keys.mjs >> .env.prod`, ardından eski yer tutucu satırları silin). PowerShell 5.1'de `>>` yönlendirmesi UTF-16 yazar ve dosya bozulur. Bu nedenle PowerShell'de yönlendirme kullanmayın, çıktıyı kopyalayıp yapıştırın.
  - `DATA_ENCRYPTION_KEY`'i **değiştirmeyin ve ayrıca yedekleyin.** Telegram sohbet kimlikleri ve proxy URL'leri bununla şifrelenir. Yalnız veritabanı yedeği yetmez, çünkü anahtar olmadan şifreli alanlar okunamaz. Rotasyon için bkz. [security.md](security.md#data_encryption_key-rotasyonu).
- `SEED_ON_MIGRATE=true` ile `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` yalnızca **ilk kurulumda** kullanılır. Seed her çalıştığında bu hesabı yeniden `SUPER_ADMIN` + `ACTIVE` yapar, yani askıya alınmış ya da rolü düşürülmüş bir hesabı geri getirir. İlk kurulumdan sonra üç satırı silin. Production'da parola en az 12 karakter olmalıdır ve `<`/`>` içeremez, böylece yer tutucunun kopyalanması reddedilir. Girişten sonra parolayı panelden değiştirin.

### Kabuk hijyeni ve sır ifşası

- **Temiz kabuk kullanın.** Compose'u çalıştıran kabukta export edilmiş aynı adlı değişkenler `--env-file` değerlerini **ezer**. Örneğin geliştirme `.env`'inden kalmış bir `DATABASE_URL` ya da `SMTP_HOST` sessizce dosyadaki değerin önüne geçer. Bu yüzden tüm compose komutlarını şu biçimde çalıştırın:
  ```bash
  env -i HOME="$HOME" PATH="$PATH" docker compose --env-file .env.prod <komut>
  ```
  Bu dokümandaki örnekler kısalık için `dc` takma adını kullanır:
  ```bash
  dc() { env -i HOME="$HOME" PATH="$PATH" docker compose --env-file .env.prod "$@"; }
  ```
- **`docker compose config` ve `docker inspect <konteyner>` çözülmüş env'i açık metin yazdırır.** Bu çıktıda parolalar, JWT özel anahtarı ve `DATA_ENCRYPTION_KEY` görünür, bu yüzden çıktıyı log'a, issue'ya ya da sohbete yapıştırmayın. Sağlık durumu için yalnızca `docker inspect --format '{{json .State.Health}}' <konteyner>` kullanın.
- Uygulamalar production'da env'i açılışta yeniden doğrular. Eksik ya da güvensiz bir değerde süreç açılmaz. Hata mesajı değişkenin adını ve nedenini söyler, değerini yazdırmaz. Kurallar: [security.md](security.md#production-env-kuralları).

## İlk kurulum

```bash
git clone <repo-url> oto && cd oto
cp .env.prod.example .env.prod && chmod 600 .env.prod   # doldurun (yukarıya bakın)
dc up -d --build --wait          # imajları derler, migrate + seed, servisleri healthcheck'e kadar bekler
dc ps                            # hepsi healthy; migrate "exited (0)"
curl -fsS https://<alan-adı>/api/v1/health/ready
```

Kurulumdan sonra:

1. `.env.prod` içinde `SEED_ON_MIGRATE`, `SEED_ADMIN_EMAIL` ve `SEED_ADMIN_PASSWORD` satırlarını silin ya da yorum yapın.
2. `https://<alan-adı>/admin` adresinden giriş yapın ve parolayı değiştirin.
3. Telegram kullanılacaksa webhook'u kurun: [telegram-bot.md](telegram-bot.md).
4. Yedeklerin sunucu dışına kopyalanmasını ayarlayın (**zorunlu**): [backup-restore.md](backup-restore.md#sunucu-dışı-kopya-zorunlu).
5. İlk elle yedeği alın: `dc exec -u postgres backup backup.sh`.

## Güncelleme

```bash
dc exec -u postgres backup backup.sh                      # 1. migration içeren sürümlerden önce elle yedek
for s in api web worker migrate backup; do                 # 2. geri dönüş için mevcut imajları etiketle
  docker tag oto/$s:latest oto/$s:prev
done
git pull --ff-only                                         # 3. yeni sürüm
dc up -d --build --wait                                    # 4. derle, migrate, servisleri yeniden oluştur
```

- `migrate` her `up` çalıştığında yeniden çalışır. `prisma migrate deploy` idempotenttir, uygulanmış migration'ları atlar. api, worker ve scheduler, migrate başarıyla bitmeden başlamaz.
- Worker ve scheduler SIGTERM ile kapanır. Aktif işler `SHUTDOWN_TIMEOUT_MS` (varsayılan 30 sn, en fazla 38 sn) kadar beklenir. Süre aşılırsa worker zorla kapanır ve işler BullMQ'da "stalled" olarak yeniden işlenir. Compose `stop_grace_period: 45s` bu sınırı, 5 sn'lik zorla kapatma payını ve Redis/Prisma bağlantılarının kapanması için ~2 sn'yi kapsar. `SHUTDOWN_TIMEOUT_MS`'i 38000'in üzerine çıkarmak env doğrulamasında reddedilir. Böyle bir kural olmasaydı Docker 45. saniyede SIGKILL gönderirdi.
- api `stop_grace_period: 20s` ile açık SSE ve HTTP bağlantılarını kapatır. Tarayıcı istemcileri yeniden bağlanır.
- Düzgün kapanan worker'lar heartbeat anahtarlarını siler. SIGKILL ile ölen bir worker'ın kaydı 24 saat kalır ve bir kez `worker:<host>:<pid>:lost` alarmı üretir ([alarms.md](alarms.md)).
- Derleme ayrıntıları:
  - Taban imaj `node:22.23.3-alpine3.24` olarak sabitlenmiştir. Taban imaj güncellenirken dört Dockerfile birlikte değişir.
  - Bağımlılıklar `pnpm fetch` ile deps katmanına alınır, ardından `pnpm install --offline --frozen-lockfile` çalışır.
  - Dağıtım için `pnpm --config.inject-workspace-packages=true --filter <app> deploy --prod --offline /out` kullanılır. `--legacy` kullanılmaz, çünkü ağ ister.
  - Sırlar build argümanı olarak verilmez.
  - Derlemeyi doğrulamak için: `sh scripts/docker-build-check.sh`.

### Geri dönüş (rollback)

```bash
env -i HOME="$HOME" PATH="$PATH" OTO_TAG=prev docker compose --env-file .env.prod up -d --no-build --wait
```

- `OTO_TAG` burada bilinçli olarak kabuktan verilir ve dosyadaki değeri ezer. `git checkout <önceki-commit>` ile kaynak kodu da geri alın ki sonraki `--build` yanlış sürümü derlemesin.
- **Migration'lar yalnızca ileri yönlüdür.** Yeni sürüm şemayı geriye uyumsuz değiştirdiyse eski imajlar yeni şemayla çalışmayabilir. Bu durumda güncellemeden önce alınan yedeği geri yükleyin ([backup-restore.md](backup-restore.md#geri-yükleme-prosedürü)), sonra `prev` imajlarıyla başlatın.
- Kayıt defterinden çekilecekse `OTO_IMAGE_PREFIX`/`OTO_TAG` ile sürüm etiketleri (ör. git kısa hash) kullanmak `prev` etiketlemesinden daha güvenlidir.

## Web ve `API_ORIGIN`

- `API_ORIGIN` (`http://api:3001`) **derleme anında** Next rewrites'a gömülür ve gizli değildir. Derlenen değer imajda `.next/build-api-origin` dosyasına yazılır.
- Konteynerin çalışma zamanı `API_ORIGIN` değeri bundan farklıysa web açılışta **durur** (çıkış 1). Hata mesajı nedeni yazar, değeri yazmaz. API adresini değiştirmek için imajı yeni `--build-arg API_ORIGIN=...` ile yeniden derleyin.
- `CSP_IMG_EXTRA` çalışma zamanında okunur: boşlukla ayrılmış, isteğe bağlı http(s) origin listesidir. `img-src` zaten her `https:` kaynağına izin verir. Bu değişken yalnız **http** üzerinden sunulan ilan fotoğrafı origin'leri için gerekir. Geçersiz bir değerde web açılmaz. Bkz. [security.md](security.md#csp-ve-güvenlik-başlıkları).

## Caddy

- Tek origin sağlar: tarayıcı yalnızca `https://<SITE_ADDRESS>` ile konuşur ve çerezler birinci taraf olur. HTTP (80) kalıcı olarak HTTPS'e yönlendirilir.
- HSTS (`max-age=31536000; includeSubDomains`) yalnızca HTTPS sitesinde verilir. `Server` ve `X-Powered-By` başlıkları silinir.
- SSE uçlarında (`/api/v1/.../stream`) `flush_interval -1` kullanılır, sıkıştırma ve tamponlama yoktur. `/api/*` gövdeleri 1 MB ile sınırlıdır; api kendisi de 100 KB ile sınırlar.
- `caddydata` volume'ü TLS sertifikalarını ve ACME hesabını tutar ve **kalıcı olmalıdır**. Silinirse yeniden sertifika alınır, bu da Let's Encrypt oran sınırına takılabilir.
- Caddy'nin önüne bir CDN ya da yük dengeleyici konursa Caddyfile'a `trusted_proxies` eklenmeli ve api `TRUST_PROXY` değeri artırılmalıdır.

## Redis

- Parola süreç argv'sine girmez. Açılışta konteyner içinde yalnız `redis` kullanıcısının okuyabildiği (`0600`) `/tmp/redis-auth.conf` dosyasına `requirepass` olarak yazılır. Değer konteyner env'inde durur, yani `docker inspect` onu gösterir.
- `dc exec redis redis-cli ping` komutunda parola `REDISCLI_AUTH` ile otomatik verilir. Komut satırına parola yazmayın.
- `noeviction`: bellek dolarsa yazmalar hata verir ama BullMQ anahtarları silinmez. Redis bellek kullanımını izleyin.

## Ölçekleme ve bağlantı bütçesi

- **Worker:** `.env.prod` içinde `WORKER_REPLICAS=N` ayarlayın ve `dc up -d --wait` çalıştırın. Worker'lar yatay ölçeklenir. İşler BullMQ üzerinden paylaşılır, kaynak başına hız limiti Redis'te ortaktır.
- **Scheduler daima tek örnektir.** Redis `scheduler:leader` kilidi (`SET NX PX 30000`, 10 sn'de bir Lua CAS ile yenilenir) ikinci bir örneği zaten bekletir: kilidi alamayan örnek tick yapmaz ve `scheduler standby: leader lock held by another instance` (`info`) logunu yazar. Yine de ölçeklemeyin, `deploy.replicas: 1` sabittir. Saklama temizliği ve alarm monitörü de yalnız lider örnekte çalışır.
- **api** tek örnek olarak tasarlanmıştır. Compose'da replika ayarı yoktur.

### `connection_limit` hesabı

Her süreç kendi Prisma havuzunu açar. Havuz boyutu `DATABASE_URL`'deki `?connection_limit=N` değeridir. Compose bu değeri `*_DB_CONNECTION_LIMIT` değişkenlerinden kurar.

| Süreç | En az (production'da altında açılmaz) | Compose varsayılanı |
|---|---|---|
| worker | `SCRAPE + ANALYZE + MATCH + NOTIFY_CONCURRENCY + 5 (notify-telegram) + 3 (pay)`: varsayılanlarla `2+4+4+8+5+3 = 26` | `WORKER_DB_CONNECTION_LIMIT=30` |
| scheduler | `3` (kuyruk tüketmez) | `SCHEDULER_DB_CONNECTION_LIMIT=5` |
| api | kural yok | `API_DB_CONNECTION_LIMIT=10` |

- Worker production'da `connection_limit` yoksa ya da formülün altındaysa **açılmaz**. Mesaj gereken en az değeri söyler. Geliştirmede yalnızca uyarır.
- Eşzamanlılıkları (`*_CONCURRENCY`) artırırsanız `WORKER_DB_CONNECTION_LIMIT`'i de artırın.
- **Postgres toplam bütçesi** şu koşulu sağlamalıdır:
  ```
  API_DB_CONNECTION_LIMIT + WORKER_REPLICAS × WORKER_DB_CONNECTION_LIMIT + SCHEDULER_DB_CONNECTION_LIMIT + ~10 < POSTGRES_MAX_CONNECTIONS
  varsayılanlar: 10 + 2×30 + 5 + 10 = 85 < 150
  ```
  `~10` payı migrate, yedek (gece dump'ı sırasında 2 bağlantı) ve elle `psql` içindir. Örneğin 4 worker replikasıyla `10 + 4×30 + 5 + 10 = 145` olur ve sınıra dayanır. Bu durumda `POSTGRES_MAX_CONNECTIONS=200` yapın. Bu değer postgres'in yeniden başlatılmasını gerektirir: `dc up -d postgres`.

## Doğrulama araçları (yerel / CI)

| Komut | Ne yapar |
|---|---|
| `sh scripts/docker-build-check.sh` | Dört uygulama imajını (api, worker, web, migrate) derler. Şunları doğrular: non-root kullanıcı, imajda `.env` olmaması, `NODE_ENV=production`, workspace paketlerinin çözülebilmesi, Prisma musl motoru, `build-api-origin` kaydı ve api'nin güvensiz production env'de açılmaması |
| `sh scripts/prod-smoke.sh` | Yığını `oto-smoke` projesi olarak `https://oto.localtest.me:8443` adresinde (Caddy `tls internal`) kurar. Uçtan uca kontrolleri çalıştırır, sonra `down -v` yapar. `SMOKE_BUILD=0` mevcut imajları kullanır |
| `sh scripts/backup-restore-check.sh` | Yedek → rotasyon → geri yükleme testi döngüsünü ayrı bir compose projesinde (`oto-backup-check`) doğrular. Yalnız backup imajını derler; mevcut `oto/migrate` imajını kullanır, bu yüzden önce onu güncel derleyin |

## Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| `... zorunlu` ile compose başlamıyor | `.env.prod` içinde `[zorunlu]` satır eksik |
| api/worker `Invalid environment: <VAR>: ...` ile çıkıyor | Production env kuralı ihlal edildi. Mesajdaki değişkeni düzeltin ([security.md](security.md#production-env-kuralları)) |
| worker `connection_limit ... en az N olmalı` | `WORKER_DB_CONNECTION_LIMIT`'i formüle göre artırın |
| web `API_ORIGIN: derleme anındaki değerle aynı olmalı` | Runtime `API_ORIGIN` ile build arg farklı. İmajı yeniden derleyin |
| migrate `P1001` | Postgres hazır değil. Healthcheck TCP üzerinden yapılır, birkaç saniye sonra `dc up -d --wait` komutunu yeniden çalıştırın |
| Ayarlar uygulanmıyor gibi | Kabukta aynı adlı export edilmiş değişken var. `env -i` ile çalıştırın |
