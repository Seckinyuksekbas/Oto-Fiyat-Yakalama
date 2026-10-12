# @oto/e2e: uçtan uca testler

Playwright ile derlenmiş yığına karşı gerçek tarayıcı senaryoları. Yalnızca yerel demo-site hedeflenir (kaynak etiği).

| Dosya | Kapsam |
|---|---|
| `tests/user-journey.spec.ts` | Kayıt, Mailpit doğrulama, Telegram bağlama (deep-link → sahte Telegram `/start`), profil, demo-site'a %25 indirimli ilan, ardından 60 sn içinde canlı toast, zil 1, liste, Telegram mesajı ve "Analizi gör" → `/ilan/:id`. Son olarak admin'de tarama işi ve SENT bildirimi |
| `tests/admin-journey.spec.ts` | Dry-run, yeniden analiz (DB'de yeni analiz), Telegram 403 → FAILED → yeniden dene → SENT, `minComparables` (yeniden yüklemede kalıcı), captcha → kaynak PAUSED + genel bakış alarmı → yeniden etkinleştirme |
| `tests/csp.spec.ts` | Oturumsuz genel sayfalar, kullanıcı ve admin sayfaları: nonce CSP başlığı, ihlal 0, CSP konsol/`pageerror` 0, hidrasyon kanıtı (tema menüsü). İlan görseli gerçekten yüklenir |

## Çalıştırma

```bash
pnpm build                                     # api, worker, demo-site dist'leri (web e2e için ayrıca derlenir)
pnpm --filter @oto/e2e exec playwright install chromium   # ilk sefer
pnpm db:up                                     # Postgres 5433, Redis 6380, Mailpit 1025/8025 (yoksa setup kaldırır)
pnpm e2e
```

İsteğe bağlı ortam değişkenleri:

| Değişken | Açıklama |
|---|---|
| `E2E_WEB_REF=<git ref>` | Web'i çalışma ağacı yerine o commit'ten derler. Çalışma ağacında yarım web değişikliği varken kullanılır. **Karışık kaynak:** yalnızca `apps/web` ref'ten gelir; `@oto/shared`, `node_modules` (`pnpm-lock.yaml`) ve api/worker/demo-site dist'leri çalışma ağacındandır |
| `E2E_DATABASE_URL` | Varsayılan `postgresql://oto:oto@127.0.0.1:5433/oto_e2e?connection_limit=30` |
| `E2E_REDIS_URL` | Varsayılan `redis://127.0.0.1:6380/14` |
| `E2E_ALLOW_REDIS_DB` | Redis db 14 dışında bir db'nin boşaltılmasına açıkça izin verir |
| `MAILPIT_URL` | Varsayılan `http://127.0.0.1:8025` |

Teşhis:
- Süreç logları `apps/e2e/.logs/` altındadır.
- Başarısız testlerde Playwright raporuna son tarama işleri, eşleşme bildirimleri ve maskelenmiş (`redactSecrets`) log kuyrukları eklenir. Trace ve ekran görüntüsü `test-results/` altındadır.

## Önkoşullar
- Node 22, pnpm 10, Docker (dev compose).
- Boş portlar: 3100 (web), 3101 (api), 4100 (demo-site), 4200 (sahte Telegram).
- Kökte `pnpm build` yapılmış olmalı. Web, `apps/e2e/.web-build/` kopyasında `API_ORIGIN=http://127.0.0.1:3101` ile ayrıca derlenir. Kaynak özeti (apps/web, packages/shared/src, pnpm-lock.yaml, API_ORIGIN) değişmezse yeniden kullanılır.
- Tarayıcı web'e `http://web.oto-e2e.test:3100` adıyla gider. `.test` hiç çözülmez; Chromium `--host-resolver-rules` ile 127.0.0.1'e eşler. Loopback olmayan ad gerekir, çünkü worker Telegram "Analizi gör" düğmesini yalnızca herkese açık görünen `PUBLIC_BASE_URL` için ekler.

## CI gereksinimleri
- Servisler: Postgres 16 (5433), Redis 7 (6380), Mailpit (1025/8025). Ya `docker compose -f docker-compose.dev.yml up -d` ya da eşdeğer servis konteynerleri kullanılır. Farklı adres için `E2E_DATABASE_URL`/`E2E_REDIS_URL`/`MAILPIT_URL` verilir.
- `pnpm install --frozen-lockfile && pnpm build && pnpm --filter @oto/e2e exec playwright install --with-deps chromium && pnpm e2e`.
- `CI=1` iken raporlayıcılar şunlardır: `list` + `github` (açıklamalar) + `html` (`apps/e2e/playwright-report/`). `playwright-report/`, `test-results/` ve `.logs/` artefakt olarak yüklenmelidir.
- Web e2e derlemesi `NEXT_STANDALONE=0` ile yapılır ve `next start` ile çalışır; Linux/CI'da da standalone üretilmez.

## Bilinçli sınırlar
- api, worker ve scheduler `NODE_ENV=development` ile çalışır:
  - `test` olmaz: Telegram polling yalnız `NODE_ENV!=test` iken otomatik başlar.
  - `production` olmaz: localhost/http adreslerini reddeder; demo-site ve `SEED_DEMO_SOURCE` de production'da çalışmaz.
- Eşzamanlılık düşürülmüştür (`SCRAPE 1`, `ANALYZE`/`MATCH`/`NOTIFY` 2). Kaynak 10 sn'de bir taranır. Isınmadan sonra taramalar yalnızca en yeni 2 sayfayı okur (`maxPages: 2`); kaldırma tespiti bu yüzden e2e'de çalışmaz.
- Bu nedenle e2e şunları **kapsamaz**:
  - production env doğrulaması
  - `COOKIE_SECURE`/HTTPS
  - Telegram webhook modu
  - production'da özel adres engeli (`blockPrivateAddresses`)
  - standalone web çıktısı
  - Caddy/HSTS
  - gerçek SMTP/TLS
  - yüksek eşzamanlılık altındaki davranış
- Bu production yolları `scripts/prod-smoke.sh` ile (production compose'a karşı duman testi) kapsanır.

## Temizlik ve güvenlik korumaları
- **Yıkıcı adımlar** (`prisma migrate reset`, `FLUSHDB`) yalnızca veritabanı adı `_e2e` ile bitiyorsa ve Redis db 14 ise (ya da `E2E_ALLOW_REDIS_DB` açıkça verilmişse) çalışır; aksi halde setup durur.
- **Süreç temizliği:**
  - Her süreç `{name, pid, startedAt, cmd}` olarak `.state/pids.json`'a yazılır.
  - Öldürmeden önce PID'in komut satırı hâlâ kayıttaki betiği içeriyor mu diye bakılır (Windows: `Get-CimInstance Win32_Process`, Linux: `/proc/<pid>/cmdline`, diğer: `ps`). Değilse PID yeniden kullanılmış sayılır, uyarı yazılır ve süreç öldürülmez.
  - Öldürme yöntemi: Windows'ta `taskkill /T /F`, POSIX'te süreç grubu.
  - Temizlik dört noktada yapılır: setup başında (yarım kalmış koşu), setup hatasında, `global-teardown`'da ve süreç çıkışında.
- **Sırlar:** JWT anahtarları, şifreleme anahtarı, seed admin ve sahte bot token'ı çalışma anında üretilir; repoda token biçimli literal yoktur.
- **Senaryo yalıtımı:**
  - Her senaryonun kendi marka/modeli vardır.
  - admin-journey `afterAll` şunları geri alır: demo-site modu, PAUSED kalmış kaynak ve özgün `analysis.settings`.
- **Bekleme:** yalnızca `expect.poll`, locator zaman aşımları, `toPass` ve `waitForResponse` kullanılır; sabit `waitForTimeout` yoktur.
