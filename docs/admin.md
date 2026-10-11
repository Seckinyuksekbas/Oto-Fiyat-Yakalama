# Admin paneli (Plan 07)

Yöneticilerin kullanıcıları, abonelikleri, ilanları/analizleri, veri kaynaklarını, kuyrukları, worker'ları, bildirimleri, paketleri ve sistem ayarlarını yönettiği ve canlı alarmları izlediği bölüm. API: `apps/api/src/modules/admin/*` (`/api/v1/admin/*`); arayüz: `apps/web/src/app/admin/*` (rotalar ve istemci kuralları için bkz. [web.md](web.md)). Tasarım: spec §6–§9.

## Roller ve yetki matrisi

- `USER` hiçbir `/admin` route'una erişemez (403). `ADMIN` ve `SUPER_ADMIN` aşağıdaki matrise göre erişir.
- Rol her istekte DB'den okunur (`RolesGuard`): rol düşürme, askıya alma ya da oturum iptali bir sonraki istekte etkilidir. Uzun ömürlü SSE akışları da periyodik olarak yeniden kontrol edilir (bkz. [Canlı akış](#canlı-akış-sse)).
- Arayüzdeki rol kontrolü yalnızca görünürlük içindir: ADMIN, SUPER_ADMIN'e özel eylemleri görmez. Asıl yetki API'dedir.
- Matris controller meta verisinden (`@Roles`) türetilmiştir. `test/admin-rbac.e2e.spec.ts`, route listesini meta veriden otomatik çıkararak USER için her route'ta 403'ü ve ADMIN için SUPER_ADMIN route'larında 403'ü doğrular.

| Route | ADMIN | SUPER_ADMIN | Denetim aksiyonu |
|---|:-:|:-:|---|
| `GET /admin/overview`, `GET /admin/stream` (SSE) | ✓ | ✓ | — |
| `GET /admin/users`, `GET /admin/users/:id` (+ `/search-profiles`, `/notifications`, `/usage`) | ✓ | ✓ | — |
| `PATCH /admin/users/:id` (ad) | ✓ | ✓ | `user.update` |
| `POST /admin/users/:id/suspend`, `/activate` | ✓¹ | ✓ | `user.suspend`, `user.activate` |
| `PATCH /admin/users/:id/subscription` | ✓ | ✓ | `user.subscription` |
| `PATCH /admin/users/:id/role` | — | ✓ | `user.role` |
| `DELETE /admin/users/:id` | — | ✓ | `user.delete` |
| `GET /admin/listings`, `/listings/:id`, `/listing-issues`, `/analyses`, `/analyses/:id` | ✓ | ✓ | — |
| `POST /admin/listings/:id/reanalyze` | ✓ | ✓ | `listing.reanalyze` |
| `GET /admin/sources`, `/sources/:id`, `/sources/:id/stats` | ✓ | ✓ | — |
| `POST /admin/sources`, `PATCH /admin/sources/:id` | ✓ | ✓ | `source.create`, `source.update` |
| `POST /admin/sources/:id/activate`, `/pause` | ✓ | ✓ | `source.activate`, `source.pause` |
| `POST /admin/sources/:id/test-scrape` | ✓ | ✓ | `source.test-scrape` |
| `GET /admin/jobs`, `/jobs/:id` | ✓ | ✓ | — |
| `GET /admin/proxies`; `POST /admin/proxies`, `PATCH /admin/proxies/:id`, `POST /admin/proxies/:id/check` | ✓ | ✓ | `proxy.create`, `proxy.update`, `proxy.check` |
| `GET /admin/queues`; `POST /admin/queues/:name/retry-failed`, `/clean` | ✓ | ✓ | `queue.retry-failed`, `queue.clean` |
| `GET /admin/workers` | ✓ | ✓ | — |
| `GET /admin/notifications`, `/notifications/latency`; `POST /admin/notifications/retry` | ✓ | ✓ | `notification.retry` |
| `GET /admin/match-dispatches/stuck`; `POST /admin/match-dispatches/:analysisId/reset` | ✓ | ✓ | `match-dispatch.reset` |
| `GET /admin/plans` | ✓ | ✓ | — |
| `POST /admin/plans`, `PATCH /admin/plans/:id` | — | ✓ | `plan.create`, `plan.update` |
| `GET /admin/settings` | ✓ | ✓ | — |
| `PATCH /admin/settings` | — | ✓ | `settings.update` |
| `GET /admin/audit-logs`, `GET /admin/system-logs` | ✓ | ✓ | — |

¹ ADMIN, bir SUPER_ADMIN'i askıya alamaz (403). Paketler, Ayarlar ve Denetim sayfaları arayüzde yalnızca SUPER_ADMIN'e görünür. Denetim kayıtları API'de ADMIN'e de açıktır.

## Atomik denetim

- Her admin mutasyonu kendi transaction'ında `AuditService.recordInTx(tx, ctx, entry)` ile denetim kaydı yazar. Kayıt aktörü, aksiyonu, hedefi (`targetType`/`targetId`), `before`/`after` değerlerini ve IP'yi içerir. Mutasyon geri alınırsa denetim kaydı da geri alınır.
- `@Audited(action)` yalnızca kapsama meta verisidir. Eski `AuditInterceptor` kaldırıldı. Aktör, IP ve aksiyon servise `@AuditCtx()` param dekoratörüyle geçer. `test/audit-coverage.e2e.spec.ts` her `/admin` mutasyon route'unda hem `@Audited` hem `@AuditCtx` arar.
- **No-op yazılmaz:** durum değişmiyorsa (zaten askıda olan kullanıcıyı askıya almak, zaten duraklatılmış kaynağı duraklatmak gibi) mutasyon ve denetim satırı yazılmaz. Yanıt 200 ve mevcut durumdur.
- **İstisnalar (atomik değil):**
  - Kuyruk eylemleri (`queue.retry-failed`, `queue.clean`) denetim kaydını Redis/BullMQ işleminden SONRA yazar, çünkü Redis ile DB arasında ortak transaction yoktur.
  - Yeniden analiz denetimi de iş kuyruğa eklendikten sonra yazılır.
- **Toplu bildirim yeniden denemesi:** tek denetim satırı yazılır. `targetId` değeri `bulk:<n>` biçimindedir; `n` yeniden kuyruğa alınan satır sayısıdır.
- Arayüz: `/admin/denetim` sayfası önce/sonra farkını (JSON diff) gösterir ve hedef kaynağa bağlantı verir.

## Kullanıcı ve abonelik işlemleri

- **Liste/arama:** offset `{ items, total }`, `pageSize ≤ 100`, sıralama beyaz listesi. Tüm `contains` aramaları `escapeLike` ile `%`, `_` ve `\` kaçışlıdır. Prisma `contains` joker karakterleri kaçışlamaz; bu bir testle doğrulanmıştır.
- **DELETED kullanıcı:** `GET /admin/users/:id` 200 döner, `status: 'DELETED'` ve anonim alanlarla. Listede `status=DELETED` süzgeciyle görünür. Mutasyonlar 404 verir.
- **Askıya alma:** tüm oturumlar iptal edilir. PENDING bildirimler `FAILED` (`lastError='USER_INACTIVE'`) olur. Günlük kota sayımı `USER_INACTIVE` satırlarını saymaz (api ve worker aynı NULL-güvenli tanımı kullanır).
- **Silme (KVKK):** hesap anonimleştirilir (`anonymizeUser`, `/me` hesap silmeyle ortak). PENDING bildirimler `FAILED (USER_INACTIVE)` olur. Kullanıcıya ait önceki denetim satırlarının `before`/`after` değerleri `{ redacted: true }` ile değiştirilir; denetim satırı kalır, kişisel veri kalmaz.
- **Son süper admin koruması:** son ACTIVE SUPER_ADMIN'in rolü düşürülemez, silinemez ve askıya alınamaz (409).
  - Kontrol transaction içinde, süper admin kümesi üzerinde `SELECT … FOR UPDATE` kilidiyle yapılır. Eşzamanlı iki istek de korunur.
  - Aynı kilit `/me` üzerinden kendi hesabını silme yolunu da kapsar.
- **Abonelik değişimi** (`PATCH /admin/users/:id/subscription {planId, endsAt, limitOverrides}`):
  - Yeni ACTIVE abonelik oluşturulur ve öncekiler `CANCELED` olur.
  - Fazla ACTIVE arama profilleri en yeniden başlayarak PAUSED yapılır.
  - Pasif pakete atama yapılamaz (409).
  - Admin kendi aboneliğini değiştiremez.
  - `limitOverrides` `limitOverridesSchema` ile doğrulanır ve paketlerle aynı üst sınırlara (`PLAN_MAXIMA`, `@oto/shared`) tabidir.
  - Profil üst sınırı `maxSearchProfilesFor` ile hesaplanır: e-postası doğrulanmamış kullanıcı için en fazla 1.
- **Süresi dolan abonelik:** scheduler'ın günlük süpürmesi ACTIVE abonelikleri `EXPIRED` yapar. Limiti aşan profiller PAUSED olur ve kullanıcıya IN_APP SYSTEM bildirimi gider (bkz. [analysis-engine.md](analysis-engine.md)).
  - Süpürme başarısız olursa gün işareti silinmez, ömrü 10 dk'ya düşürülür: hata sürerken her tick'te yeniden denenmez (deneme başına bir log); 10 dk sonra yalnızca eksik kalanlar onarılır.
- **Abonelik değişimi ile paket pasifleştirme yarışı:** abonelik değişimi paket satırını `FOR SHARE` ile kilitleyip `isActive`'i yeniden okur; paket güncellemesi `FOR NO KEY UPDATE` alır. Eşzamanlı pasifleştirilen pakete abonelik atanmaz (409).
- **Kullanıcı detayı** (`GET /admin/users/:id`) listeyle aynı canlı abonelik tanımını kullanır: ACTIVE ve (`endsAt` boş ya da gelecekte), en yeni `startsAt`. Süresi geçmiş ama hâlâ ACTIVE satır gösterilmez.

## İlanlar ve analizler

- `GET /admin/listings` (+ detay), `GET /admin/listing-issues` (sorunlu kayıtlar), `GET /admin/analyses` (+ detay, açıklama JSON'u).
- **Yeniden analiz** (`POST /admin/listings/:id/reanalyze`):
  - `analyze` işini `reason: 'MANUAL'` ile ekler (jobId `analyze-manual-<id>-<ts>`). REMOVED ilan için 409 döner.
  - Redis `SET NX EX 60` ile 60 sn tekilleştirilir: bu süredeki yinelenen tıklamalar aynı jobId'yi alır ve yeniden denetlenmez.
  - `listing.reanalyze` denetim kaydı ve kuyruğa ekleme aynı transaction'dadır: kuyruğa eklenemezse (503) denetim kaydı da yazılmaz. Ekleme başarılı ama commit başarısızsa iş kuyrukta kalır (MANUAL analiz idempotenttir) ve istek hata döner.
  - MANUAL analiz "maddi değişiklik" eşiğini atlar ve her zaman yeni satır yazar.
  - **Eşik altı değişiklik kullanıcı bildirimi doğurmaz:** "daha eşleşebilir" türevi `NEW` üretilmez. Gerçek `NEW`/`PRICE_DROP`/`RELIST` olayları her zamanki gibi yayılır (bkz. [analysis-engine.md](analysis-engine.md)).
  - Arayüz, `latestAnalysisId` değişene kadar ilanı yoklar.
- **Takılı eşleştirme gönderimleri:** `matchDispatchAttempts ≥ 10` ve `matchQueuedAt` boş olan analizler `GET /admin/match-dispatches/stuck` ile listelenir. `POST …/:analysisId/reset` sayacı sıfırlar ve yeniden gönderir (denetimli). Bu satırlar için bir kez `match-dispatch-stuck:<id>` alarmı üretilir.

## Kaynak yaşam döngüsü

**İzin → oluştur → dry-run → etkinleştir → izleme → duraklat / yeniden aç**

1. **İzin:** kaynak yalnızca lisanslı/izinli olabilir. `permissionType`, `permissionNote` ve `permissionVerifiedAt` doldurulmadan etkinleştirme ve test taraması yapılamaz (409). Ayrıntılar: [adding-a-source.md](adding-a-source.md).
2. **Oluştur:** `POST /admin/sources` (`isActive=false` başlar).
   - `config.baseUrl` kayıtta SSRF denetiminden geçer (bkz. [SSRF kuralları](#ssrf-kuralları)).
   - `adapterKey` paylaşılan `ADAPTER_KEYS` listesinden olmalıdır.
   - Yanıtlarda `config.baseUrl`'in sorgu dizisi maskelenir.
   - **Gizli config anahtarları** (`apps/api/src/modules/admin/config-mask.ts`):
     - **Anahtar kuralı (parça bazlı):** ad camelCase, `_`, `-` ve `.` ile küçük harfli parçalara bölünür. Bir parça `apikey`, `token`, `secret`, `pass`, `password`, `passwd`, `auth`, `authorization`, `credential`, `credentials` ise (çoğulları dahil) anahtar gizlidir. `key` parçası yalnızca ad tek başına `key` ise ya da `apiKey` / `privateKey` / `secretKey` / `accessKey` ile bitiyorsa gizlidir. Alt dize eşleşmesi yapılmaz: `keywords`, `keyboard`, `authorName`, `bypassCache`, `passengers`, `sortKey`, `searchKey`, `maxKeys` gizli değildir.
     - Gizli anahtarın **tüm torunları** gizlidir (ör. `auth: { user, pass }` → ikisi de). String/sayı değerler iç içe nesne ve dizilerde de liste/detay yanıtlarında ve denetim kaydının `before`/`after` alanlarında `"***"` olarak döner. Boolean ve null olduğu gibi kalır.
     - `PATCH` config'i bütün olarak değiştirir. Gizli alanda `"***"` gönderilirse aynı yoldaki saklı değer korunur, yeni değer yazılırsa saklanır. Saklı karşılığı olmayan `"***"` 400 `VALIDATION_FAILED` döner. Anahtar sırası farkı değişiklik sayılmaz (no-op, denetim satırı yok).
     - **Diziler indeksle eşlenir:** `"***"` içeren bir dizinin uzunluğu değişmişse ya da `"***"` içeren nesne öğelerinin gizli olmayan alanları aynı indeksteki saklı öğeden farklıysa (öğe silme, ekleme, sıralama) 400 döner; o dizideki gizli değerler yeniden yazılmalıdır.
     - Oluşturmada (`POST`) saklı değer olmadığından gizli alanda `"***"` 400 döner.
     - Panelde config düzenleyicisi `"***"` değerleri olduğu gibi geri gönderebilir: "*** olarak görünen gizli değerleri değiştirmek için yeni değeri yazın".
3. **Test taraması** (`POST /admin/sources/:id/test-scrape {dryRun}`): `CollectionJob(trigger MANUAL, dryRun)` ve `scrape` işi oluşturur. Kaynak başına dakikada 1 (429), kaynakta bekleyen/çalışan iş varsa 409.
   - Dry-run etkin olmayan kaynakta da (yönetici duraklatması dahil) çalışır. Gerçek tarama (`dryRun: false`) yalnızca etkin kaynakta yapılabilir; etkin olmayan kaynakta 409 `INVALID_OPERATION`.
   - Dry-run gerçek taramayla **aynı nezaket ve robots kurallarına** uyar: robots.txt, paylaşılan hız limiti, `minRequestGapMs`, bot User-Agent.
   - Ingest, kaldırma işaretleme ve analiz yapmaz. En fazla 2 liste sayfası çekilir; ilk 20 normalize ilan ve sorun listesi `CollectionJob.dryRunResult` alanına yazılır.
   - **Engel kaynaklı `health=PAUSED` kaynakta reddedilir** (API 409, worker işi FAILED). Engel sinyalinin nedeni incelenmeden kaynağa istek atılmaz.
   - Dry-run sırasında engel sinyali (403/captcha) gelirse kaynak **PAUSED olur** ve alarm üretilir; gerçek taramadaki davranışın aynısıdır.
   - Dry-run zamanlayıcı aralığını **sıfırlamaz**: scheduler "son tarama" hesabında dry-run işlerini yok sayar.
4. **Etkinleştir** (`POST /admin/sources/:id/activate`): `permissionVerifiedAt` zorunludur. Engel kaynaklı PAUSED kaynakta health `HEALTHY` ve `consecutiveFailures=0` olur; diğer sağlık değerleri (DEGRADED/DOWN) olduğu gibi kalır. İşlem kaynak satır kilidi (`FOR NO KEY UPDATE`) altında yapılır; scheduler da aynı kilidi alır ve uygunluğu kilit altında yeniden okur.
5. **İzleme:** sağlık güncellemeleri (`SourceHealthService`) de aynı `FOR NO KEY UPDATE` satır kilidiyle oku-değiştir-yaz yapar; eşzamanlı bir admin `activate`/`pause` eski okunan durumla ezilmez. Hata metinleri (`ScrapeError.message`, `CollectionJob.errorSummary`, SystemLog bağlamı) yazım anında `redactSecrets` ile maskelenir (her `şema://` için kullanıcı bilgisi ve sorgu dizisi); okuma tarafındaki maskeleme ek savunmadır. `GET /admin/sources/:id/stats` (iş/hata istatistikleri), `/admin/isler` (toplama işleri, hata özetleri). `ScrapeError.url` ve iş özetlerindeki URL'lerin sorgu dizisi `?…` olarak maskelenir; bu her şema için geçerlidir. Alarmlar için bkz. [Alarmlar ve eşikler](#alarmlar-ve-eşikler).
6. **Duraklat** (`POST /admin/sources/:id/pause`): yalnız `isActive=false` yazar; `health` ve `consecutiveFailures` **değişmez** (denetim `before`/`after`: `{isActive, health}`). Zaten etkin olmayan kaynakta no-op.
   - **Yönetici duraklatması** (`isActive=false`, `health≠PAUSED`): scheduler atlar, dry-run çalışır, monitör alarm üretmez. Panel rozeti: "Duraklatıldı (yönetici)"; izni doğrulanmamış (hiç etkinleştirilemeyen) etkin olmayan kaynakta nötr "Zamanlama kapalı". Engel ve yönetici duraklatması birlikteyse iki rozet de görünür.
   - **Engel** (`health=PAUSED`, `SourceHealthService` yazar): dry-run ve test taraması 409; kaynak etkinse monitör `source:<id>:blocked` alarmı verir. Panel rozeti: "Engel nedeniyle duraklatıldı". Engelli kaynağı duraklatmak engeli silmez; yalnız `activate` sıfırlar.
   - **Plan 07 verisi:** Plan 07'de duraklat ayrıca `health=PAUSED` yazıyordu. `20261019000000_admin_pause_health_restore` göçü, son duraklat/etkinleştir denetim satırı `source.pause` olan, `before.health` değeri engel olmayan ve duraklatmadan sonra hata görmemiş (`lastErrorAt` ≤ denetim zamanı) etkin olmayan PAUSED kaynakları duraklatma öncesi sağlığa döndürür. Ayırt edilemeyen PAUSED satırlar (denetim satırı yok ya da sonradan hata var) engel kabul edilir ve olduğu gibi kalır; yönetici nedeni inceleyip `activate` ile açar.
7. **Yeniden aç:** engelin nedeni ve izin kontrol edildikten sonra `activate`.

### Proxy'ler

- **Saklama:** proxy URL'leri şifreli saklanır (`urlEncrypted`, AES-256-GCM). Yanıtlarda maskeli gösterilir (`http://***@host:port`); kimlik bilgisi hiçbir yanıtta dönmez.
- **Sağlık kontrolü** (`POST /admin/proxies/:id/check`): `PROXY_CHECK_URL` adresine proxy üzerinden istek atar. Proxy başına 10 sn'de en fazla 1 kez yapılır (Redis NX, 429). Bağlantı anında `guardedLookup` uygulanır.
- **Proxy rotasyonuyla engel aşma yapılmaz:** engellenen kaynak PAUSED olur, başka proxy ile yeniden denenmez. Hiçbir ayar UA sahteciliği, captcha çözme ya da rotasyonla engel aşma seçeneği sunmaz.

## SSRF kuralları

Kaynak `config.baseUrl` ve proxy URL'leri admin girdisidir. İki katmanda denetlenirler:

1. **Kayıtta** (`assertPublicHttpUrl`, `@oto/server-common`):
   - Yalnızca `http(s)` kabul edilir.
   - Ad çözülür; adreslerden biri bile iç ağdaysa kayıt reddedilir. İç ağ kapsamı: loopback, private, link-local (169.254.0.0/16), CGNAT, multicast, belgeleme aralıkları, 192.0.0/24, 198.18/15, NAT64, 6to4 ve Teredo içindeki gömülü IPv4.
   - Proxy URL'lerinde kullanıcı bilgisine (`user:pass@`) izin verilir; kaynak URL'lerinde verilmez.
2. **Çekim anında** (`PoliteHttpClient`, `blockPrivateAddresses` production'da açık):
   - Bağlantı yolunda `guardedLookup` çalışır: tüm adresler çözülür, biri bile özelse bağlantı reddedilir (`OTO_PRIVATE_ADDRESS`, yeniden denenmez). Bu, DNS rebinding'e karşı korur.
   - Proxy kullanıldığında guard proxy soketine de uygulanır (`ProxyAgent` `proxyTls` lookup'ı). undici, proxy bağlantısı için `connect` seçeneğini yok sayar; bu yüzden `proxyTls` kullanılır.
   - Yönlendirmeler elle izlenir ve **her atlama** (ilk istek dahil) ayrıca denetlenir. IP sabit adreslerde undici lookup çağırmadığı için bu gereklidir. Köşeli parantezli IPv6 sabit adresler (`[::1]`, `[::ffff:127.0.0.1]`, `[::ffff:a9fe:a9fe]`) parantezleri ayıklanarak denetlenir.
   - IP sabit adres olarak verilmiş proxy de (lookup çağrılmadığından) her istekte ayrıca denetlenir.
- **Dev/test:** `ALLOW_PRIVATE_URLS` (API'de bir DI token'ı, ortam değişkeni değil) `NODE_ENV !== 'production'` iken `true` olur. Worker'da `blockPrivateAddresses` yalnızca production'da açıktır. Böylece demo-site (`127.0.0.1:4000`) çalışır.
- **Bilinen sınır:** istek proxy üzerinden gittiğinde hedef adı proxy çözer. Hedef ad için DNS denetimi istekten önce yapılır, ancak proxy tarafındaki DNS rebinding kapsanmaz.

## Kuyruk, worker ve bildirim işlemleri

- **Kuyruklar** (`GET /admin/queues`):
  - Kuyruk adları beyaz listeden gelir: `scrape`, `analyze`, `match`, `notify`, `notify-telegram`. Her biri için `waiting/active/delayed/failed/completed/prioritized/paused` sayıları döner.
  - `retry-failed` en fazla 1000 iş yeniden dener ve deneme sayısını sıfırlar. `notify`/`notify-telegram` için bu eylem bildirim yeniden denemesine eşlenir, çünkü kaynak gerçek DB satırıdır.
  - `clean {state: 'completed'|'failed', olderThanSec ≥ 3600}`.
  - Redis'e ulaşılamazsa 503 döner.
- **Worker'lar** (`GET /admin/workers`):
  - Canlı worker'lar `worker:heartbeat:*` anahtarlarından okunur (TTL ile canlılık).
  - Son görülenler 24 saat `worker:seen:*` anahtarlarında tutulur; ölü worker'lar da listelenir.
- **Bildirimler** (`GET /admin/notifications`, `/latency`):
  - Gecikme p50/p95 son 24 saat ya da 7 gün için nedene göre ayrı hesaplanır.
  - `latencyMs = sentAt − eventAt`. `eventAt`, NEW için `listing.firstSeenAt`, PRICE_DROP/RELIST için analizin `createdAt` değeridir.
- **Yeniden deneme** (`POST /admin/notifications/retry {ids}`, ≤ 100):
  - Yalnızca `FAILED` satırlar `PENDING` olur (`attempts=0`, `lastError=null`, `queuedAt=null`). Mevcut BullMQ işi önce kaldırılır, sonra yeniden eklenir.
  - Yalnızca `FAILED` satırlar işlendiği için yinelenen tıklamalar çift gönderim üretmez.
  - Uçuştaki işler atlanır (`JOB_IN_FLIGHT`). `removeOnFail` penceresinden (7 gün) eski satırlar atlanır (`TOO_OLD`).
  - `NOTIFY_JOB_OPTS.removeOnFail` 7 gündür.
  - Hata metinleri kalıcılaştırılmadan önce `redactSecrets` ile temizlenir; `bot<token>` değerleri maskelenir.
  - `SYSTEM_ALERT` satırları yalnızca hâlâ ADMIN/SUPER_ADMIN olan alıcıya gönderilir: kuyruktayken yetkisi alınan kullanıcının satırı `FAILED`/`NOT_ADMIN` olur (izleme hata oranına girmez); yeniden deneme bu satırları `NOT_ADMIN` ile atlar.

## Alarmlar ve eşikler

`MonitorService` scheduler adımı olarak en fazla `MONITOR_INTERVAL_MS` (varsayılan 60 sn) aralıkla çalışır. Eşikler `alerts.thresholds` ayarından **her monitör adımında** okunur; ayar değişikliği worker yeniden başlatılmadan etkili olur.

| Anahtar | Koşul | Seviye |
|---|---|---|
| `source:<id>:down` | Etkin kaynak DOWN (6 ardışık hata) | ERROR (kalıcı) |
| `source:<id>:blocked` | Etkin kaynak engel sinyaliyle PAUSED (yönetici duraklattığı, `isActive=false` kaynaklar alarm üretmez) | ERROR (kalıcı) |
| `source:<id>:degraded` | 3 ardışık hata (tarama sırasında) | WARN |
| `source:<id>:parse` | Monitör: son 1 saatte biten işlerde PARSE hatası / sayfa > `parserErrorRate` (en az 20 sayfa). Tarama yolu: tek işte ilanların > %20'si ayrıştırılamadı ya da sayfa yapısı tanınmadı. Aynı sorun (bozulan ayrıştırıcı) olduğundan iki yol tek anahtarı paylaşır | WARN |
| `queue:notify:depth` | `notify` + `notify-telegram` bekleyen > `notifyQueueDepth` | WARN |
| `notify:failure-rate` | Son 1 saatte MATCH bildirimleri ve dış kanal (TELEGRAM) alarm teslimleri için FAILED / (SENT+FAILED) > `notifyFailureRate` | ERROR |
| `worker:<host>:<pid>:lost` | Görülmüş ama nabzı `heartbeatMissSec`'ten eski worker | ERROR |
| `telegram:unauthorized` | Telegram Bot API 401 | ERROR |
| `match-dispatch-stuck:<id>` | Analiz 10 denemede eşleştirme kuyruğuna alınamadı | ERROR |

- **Varsayılan eşikler:** `{ notifyQueueDepth: 500, notifyFailureRate: 0.10, parserErrorRate: 0.2, heartbeatMissSec: 60 }`.
- **Susturma:** anahtar başına 30 dk (`alert:<key>` NX). Koşul sürdükçe SystemLog satırı da çoğalmaz (`alert-log:<key>`).
- **Kalıcı durumlar** (`blocked`/`down`) 6 saatte bir yeniden bildirilir (`PERSISTENT_ALERT_TTL_SEC`). Tarama yolu (`SourceHealthService`) ve monitör bu durumları aynı anahtar ve aynı 6 saatlik susturmayla bildirir: tek engel ya da tek DOWN, 6 saat boyunca adminlere tek alarm bildirimi olarak gider. Monitörün sonraki tick'leri (ör. 31 dk sonra) yeniden bildirmez. SystemLog'da her iki bileşenin satırı görünebilir.
- **Ayrıştırma sorunu** için de tarama yolu ve monitör tek anahtar (`source:<id>:parse`) kullanır; susturma 30 dk'dır.
- **Worker kaybı** bir kez bildirilir: aynı kayıp (aynı son nabız) için yinelenmez.
- **Teslim** (`AlertService`):
  - SystemLog (ERROR/WARN) yazılır.
  - Tüm ACTIVE adminlere IN_APP `SYSTEM_ALERT` bildirimi gönderilir; bildirim `user:<id>` ve `admin:events` kanallarında yayınlanır.
  - Doğrulanmış ve etkin Telegram kanalı olan aktif adminlere TELEGRAM satırı yazılır (PENDING, `notify-telegram` kuyruğu, düz metin alarm şablonu).
  - `SYSTEM_ALERT` günlük bildirim kotasından muaftır.
  - Hiç aktif admin yoksa susturma anahtarı bırakılır; sonradan eklenen bir admin alarmı yine alır.

## Canlı akış (SSE)

- `GET /admin/stream` (ADMIN+) şu olayları gönderir:
  - `ready`: tam genel bakış.
  - `alert`: `admin:events` Redis kanalından.
  - `job`: `CollectionJob` durum değişimi.
  - `kpi`: sunucuda hesaplanan, önbellekli özet.
  - `ping`.
- Akış 15 dk sonra kapanır.
- Sunucu oturumu ve rolü **30 sn'de bir** yeniden kontrol eder (`SSE_RECHECK_MS`, InfraModule'de bir DI token'ı; testler küçültür). Oturum iptal edilmişse, kullanıcı ACTIVE değilse ya da rol ADMIN altına düştüyse akış kapatılır. Kullanıcı bildirim akışı (`/me/notifications/stream`) da aynı kontrolü yapar.
- İstemci `ready` sonrası kopuşta `/me`'yi yeniler. Rol düştüyse kapı 404 gösterir ve akış **yeniden bağlanmaz**. Kararlı bağlantı olmadan 12 denemeden sonra da durur (bkz. [web.md](web.md)).

## Paketler

- `POST/PATCH /admin/plans` (SUPER_ADMIN): `planLimitsSchema` kullanılır ve `channels` içinde `IN_APP` zorunludur (400). Paket kodu benzersizdir ve değiştirilemez. Limitler `PLAN_MAXIMA` üst sınırlarına tabidir; aynı sınırlar kullanıcıya özel `limitOverrides` için de geçerlidir.

### Paket limitleri

- `PATCH /admin/plans/:id` limitleri düşürdüğünde mevcut kullanıcıların fazla ACTIVE arama profilleri **duraklatılmaz**. Kullanıcılar fazla profillerini bir sonraki abonelik değişimine (admin abonelik değişimi ya da süresi dolan abonelik süpürmesi) kadar korur. Yeni profil oluşturma ve etkinleştirme ise yeni limitle hemen sınırlanır.
- Yanıttaki `plan.usersOverProfileLimit`, canlı paketi bu olan kullanıcılardan ACTIVE profil sayısı yeni `maxSearchProfiles` sınırını aşanların sayısıdır. FREE için aboneliği olmayan (örtük FREE) kullanıcılar da sayılır. Sınır `maxSearchProfilesFor` ile hesaplanır, yani e-postası doğrulanmamış kullanıcılar için en fazla 1'dir.
- FREE paketi pasifleştirilemez (409). Paket kodları değiştirilemez. Limitlerde `IN_APP` kanalı zorunludur.
- Aktif abonesi olan bir paket pasifleştirilebilir: mevcut abonelikler sürer, ancak pakete yeni atama yapılamaz (409).

## Ayarlar ve canlı geçersiz kılma

- **Anahtarlar:** beyaz listelidir: `analysis.settings` (analiz katsayıları, `analysisSettingsSchema`) ve `alerts.thresholds` (`alertThresholdsSchema`). Bilinmeyen anahtar, yanlış tip ya da `__proto__` gibi prototip anahtarları 400 verir ve mevcut ayar korunur.
- **Kısmi birleştirme:** `PATCH /admin/settings {key, value}` gönderilen alanları saklı değerle birleştirir. Bir alana `null` göndermek o alanı **varsayılana döndürür**. Saklı değer geçersizse birleştirme yapılmaz; arayüz bunu bir uyarıyla gösterir.
- **Çapraz alan doğrulaması:** **birleştirilmiş** değer üzerinde çalışır (`smallPoolMax ≥ minComparables`, `theilSenMinPool ≥ minComparables`). Bu nedenle tek alanlı bir PATCH de çelişki üretemez. Kayıt satır kilidi altında yapılır ve denetimlidir.
- **Canlı geçersiz kılma:** commit sonrası Redis `settings:changed` kanalında yayın yapılır.
  - Worker'ların `AnalysisSettingsService` önbelleği anında `invalidate()` olur; worker log'unda görünür. 60 sn TTL yedek olarak kalır.
  - Abonelik koparsa yeniden abone olunur. Nesil sayacı, eski bir okumanın yeni değeri ezmesini önler.
  - Yayın başarısızlığı kaydı bozmaz (yalnızca log).
- `alerts.thresholds` önbelleğe alınmaz; monitör her adımda okur.

## Loglar

- `GET /admin/audit-logs`: aktör, aksiyon, hedef ve tarih süzgeçleri.
- `GET /admin/system-logs`: seviye, bileşen ve tarih süzgeçleri, sınırlı aralık.

Saklama süreleri Plan 08'dedir (SystemLog/ScrapeError 30 gün, AuditLog 1 yıl, bildirimler 90 gün).

## Yapılandırma

| Değişken | Süreç | Açıklama |
|---|---|---|
| `PROXY_CHECK_URL` | api | Proxy sağlık kontrolü hedefi (varsayılan `https://www.gstatic.com/generate_204`) |
| `MONITOR_INTERVAL_MS` | worker (scheduler) | Alarm monitörünün en kısa çalışma aralığı (varsayılan 60000, en az 1000) |

`SSE_RECHECK_MS` (30 sn) ve `ALLOW_PRIVATE_URLS` (`NODE_ENV !== 'production'`) ortam değişkeni değildir; Nest DI token'larıdır.

**Migration'lar:**
- `20261016000000_admin_ops`: yalnızca iki sütun ekler: `CollectionJob.dryRunResult` (JSONB) ve `ListingAnalysis.matchDispatchAttempts` (INTEGER, varsayılan 0).
- `20261017000000_monitor_indexes`: monitör sorguları için indeksler.

## Testler

- `apps/api/test/admin-*.e2e.spec.ts`: RBAC matrisi, kullanıcılar, ilanlar, kaynaklar, işlemler, paketler/ayarlar, genel bakış/SSE.
- `apps/api/test/audit-coverage.e2e.spec.ts`
- Worker e2e: monitor/alert, dry-run, ayar yayılımı, abonelik süpürmesi.
- Web: `apps/web` vitest testleri.
- Görsel smoke: `node apps/web/scripts/screenshots.mjs` admin sayfalarını da çeker; seed SUPER_ADMIN ile, `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` kullanılır.
