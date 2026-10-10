# Oto Fırsat Platformu — Tasarım Dokümanı (Aşama 1 MVP + Scraper Altyapısı)

- **Tarih:** 2026-10-10
- **Durum:** Onaylandı (bölüm bölüm), yazılı spec incelemesi bekleniyor
- **Kapsam:** İlk alt proje = Aşama 1 MVP + merkezi scraper altyapısı. Abonelik ödemesi (Aşama 3) ve çoklu kaynak/gelişmiş analiz (Aşama 4) ayrı spec→plan döngüleridir; şema bunlara hazır kurulur.

---

## 0. Ortak Anlayış

**Amaç:** Otomobil ilanlarını merkezi olarak toplamak, kural tabanlı ve açıklanabilir bir analizle piyasa altı fırsatları tespit etmek, kullanıcıların arama profilleriyle eşleştirmek ve eşleşmeleri mümkün olan en kısa sürede hem panel içinde (in-app) hem Telegram üzerinden bildirmek. Platform ileride ücretli abonelikle işletilecek.

**Kullanıcının söyledikleri:**
- Çok kullanıcılı yapı, süper admin + normal kullanıcı rolleri, kullanıcılar arası tam izolasyon.
- Stack: Node.js/TypeScript, NestJS, Next.js, PostgreSQL + Prisma, Redis + BullMQ, Telegram, Docker Compose.
- Mikroservis yok; modüler backend + ayrı worker süreçleri.
- Bildirimler Telegram'a ek olarak sistem içinde de görünmeli.
- Arayüz premium olmalı; seçilen yön "Gece Showroom" (Yön A).
- Veri kaynağı: kullanıcı lisans/partner anlaşması bekleyecek. O zamana kadar akış yerel demo ilan sitesiyle uçtan uca çalıştırılacak.
- Fiyat analizi: kademeli emsal + medyan yöntemi.

**Varsayımlar ve sınırlar:**
- Sahibinden ve Arabam.com için yazılı izin veya lisans olmadan adapter yazılmaz. Bu sitelerin kullanım koşulları otomatik veri toplamayı yasaklar; izinsiz kazıma hem kullanıcının kendi gereksinim dokümanına (§3) hem hukuki risk değerlendirmesine aykırıdır.
- Mimaride erişim kontrolü atlatma bileşeni bulunmaz: stealth eklentisi, parmak izi gizleme, captcha çözme, engele tepki olarak IP/UA rotasyonu yoktur. Captcha/bot-koruma servisleri (unlocker türü) bu amaçla entegre edilmez; bu firmaların izinli dataset ürünleri normal `API`/`FEED` adapter'ı olarak eklenebilir.
- Repo başlangıçta boştur (greenfield). Node 22, Docker 28 mevcuttur.

**Başarı kriterleri (MVP kabul):**
1. Kullanıcı kayıt olup arama profili oluşturabilir.
2. Admin sistemi merkezi panelden yönetebilir (kullanıcılar, ilanlar, kaynaklar, kuyruklar, bildirimler, planlar, denetim).
3. Yeni ilanlar mükerrer kayıt olmadan alınır; fiyat değişimleri geçmişe yazılır.
4. İlanlar kullanıcı filtreleriyle eşleşir; eşleşmeler in-app ve Telegram'a gider.
5. Aynı ilan için gereksiz tekrar bildirim gönderilmez.
6. Her fiyat analizi neden ve nasıl hesaplandığını gösterebilir.
7. Worker hataları ve başarısız bildirimler izlenebilir ve yeniden denenebilir.
8. Kullanıcılar başka hesapların özel verilerine erişemez (otomatik test ile kanıtlı).
9. Proje Docker Compose ile kurulur ve belgelenmiştir.
10. Scraper kaynakları bağımsız adapter'larla yönetilir; proxy opsiyoneldir; admin panelinden sağlık izlenir ve manuel test taraması başlatılır.

---

## 1. Mimari ve Bileşenler

**Yaklaşım:** pnpm workspaces monorepo, tek NestJS kod tabanı, ayrı süreçler.

```
apps/
  api/          NestJS REST (/api/v1), auth, kullanıcı + admin uç noktaları, SSE
  worker/       NestJS application context (HTTP yok); BullMQ işlemcileri; ROLE=worker|scheduler
  web/          Next.js (App Router) — /app/* kullanıcı, /admin/* admin
  demo-site/    Express + EJS sahte ilan sitesi (yalnızca dev/test)
packages/
  shared/       zod şemaları, tipler, hata kodları, enum'lar, normalize ilan modeli
  analysis/     saf TS fırsat analiz motoru (DB bağımsız)
  db/           Prisma şeması, client, seed
```

`api` ve `worker` ortak NestJS modüllerini (`packages/db`, domain servisleri) paylaşır.

**Docker Compose servisleri:**

| Servis | Görev |
|---|---|
| `caddy` | Reverse proxy: `/` → web, `/api/*` → api; prod'da otomatik HTTPS |
| `postgres` | Kalıcı veri |
| `redis` | BullMQ, rate-limit sayaçları, pub/sub, kısa önbellek |
| `migrate` | Tek seferlik `prisma migrate deploy` |
| `api` | REST + SSE |
| `worker` | Tüm kuyruk işlemcileri; `--scale worker=N` ile yatay ölçek |
| `scheduler` | Aynı imaj, `ROLE=scheduler`, tek instance; tekrarlayan job'ları kurar |
| `web` | Next.js |
| `backup` | Gecelik `pg_dump` |
| `demo-site`, `mailpit` | Yalnızca dev profili |

**Kuyruklar ve veri akışı:**

```
scheduler ──(source.intervalSec)──► [scrape]
[scrape]   adapter.listPages → parseList → (gerekirse fetchDetail) → RawListing
           └─► [ingest]  (batch; jobId = source:externalId:contentHash → idempotent)
[ingest]   zod validasyon → normalize → upsert Listing
           ├─ yeni ilan            → ListingPriceHistory ilk kayıt → [analyze] (NEW)
           ├─ fiyat/özellik değişti → history ekle → [analyze] (PRICE_DROP adayı)
           ├─ REMOVED iken geri geldi → relistedAt → [analyze] (RELIST)
           ├─ geçersiz veri         → ListingIssue; analize GİTMEZ
           └─ değişiklik yok        → lastSeenAt güncelle
[analyze]  emsal havuzu → düzeltme → IQR → medyan → ListingAnalysis → [match]
[match]    aktif SearchProfile'larla tek SQL → ListingMatch (unique) → Notification(PENDING) → [notify]
[notify]   kanal adapter'ı (IN_APP / TELEGRAM / EMAIL) → Notification durum güncelle
```

**Periyodik görevler (scheduler):** kaynak taramaları; ilan kaybolma tespiti (`lastSeenAt` eşiği → `REMOVED`); gece yeniden analizi; kaynak sağlık kontrolü; başarısız bildirim yeniden deneme taraması; log/job temizliği; bildirim sayaç sıfırlama.

**İlkeler:**
- İlan bir kez toplanır, bir kez analiz edilir, N kullanıcıya dağıtılır.
- Her aşama idempotenttir (DB unique kısıtları + BullMQ jobId).
- Kaynak izolasyonu: rate limit ve eşzamanlılık kaynak bazında (`source:{id}` Redis anahtarları); bir kaynağın hatası diğerlerini etkilemez.
- Worker heartbeat: her worker 15 sn'de bir Redis `worker:{hostname}` (TTL 45 sn) yazar.
- Gecikme hedefi: scrape anından bildirim gönderimine p95 < 60 sn.

---

## 2. Veritabanı Şeması (Prisma / PostgreSQL)

### Kimlik ve abonelik
- **User**: id, email (unique, citext), passwordHash (argon2id), name, role (`USER`/`ADMIN`/`SUPER_ADMIN`), status (`ACTIVE`/`SUSPENDED`/`DELETED`), emailVerifiedAt, kvkkAcceptedAt, lastLoginAt, createdAt, updatedAt.
- **Session**: id, userId, refreshTokenHash, familyId, userAgent, ip, expiresAt, revokedAt, createdAt.
- **EmailVerificationToken / PasswordResetToken**: tokenHash, userId, expiresAt, usedAt.
- **SubscriptionPlan**: id, code (unique), name, priceMonthly, isActive, limits JSON `{ maxSearchProfiles, maxNotificationsPerDay, channels[], opportunitiesDelayHours }`.
- **UserSubscription**: userId, planId, status, startsAt, endsAt, limitOverrides JSON. Kayıtta otomatik `FREE` atanır.

### Bildirim kanalları
- **NotificationChannel**: userId, type (`IN_APP`/`TELEGRAM`/`EMAIL`), config (AES-GCM şifreli JSON; ör. Telegram chatId), isVerified, isEnabled. unique(userId, type).
- **TelegramLinkToken**: codeHash, userId, expiresAt (10 dk), usedAt.

### Kaynak ve toplama
- **DataSource**: id, code (unique), name, adapterKey, kind (`HTTP`/`BROWSER`/`API`/`FEED`), permissionType (`LICENSED_API`/`PARTNER_FEED`/`TOS_PERMITTED`/`TEST`), permissionNote, permissionVerifiedAt, isActive, intervalSec, maxConcurrency, minRequestGapMs, config JSON, proxyConfigId?, health (`HEALTHY`/`DEGRADED`/`DOWN`/`PAUSED`), lastSuccessAt, lastErrorAt, consecutiveFailures. **Kural:** `permissionVerifiedAt` boşken `isActive=true` yapılamaz (servis + DB check constraint).
- **ProxyConfig**: id, name, urlEncrypted, isEnabled, lastCheckAt, lastLatencyMs, lastError.
- **CollectionJob**: id, sourceId, trigger (`SCHEDULED`/`MANUAL`), dryRun, status (`QUEUED`/`RUNNING`/`SUCCEEDED`/`FAILED`/`PARTIAL`), startedAt, finishedAt, pagesFetched, listingsSeen, listingsNew, listingsUpdated, errorsCount, avgResponseMs, errorSummary.
- **ScrapeError**: id, jobId, sourceId, kind (`NETWORK`/`TIMEOUT`/`HTTP_4XX`/`HTTP_5XX`/`BLOCKED`/`PARSE`/`VALIDATION`), url, message, transient, createdAt.

### İlan
- **Listing**: id, sourceId, externalId, **unique(sourceId, externalId)**, url, title, imageUrl?, make, model, trim?, year, km, fuel (enum), transmission (enum), bodyType?, color?, city?, sellerType?, damageInfo JSON `{ tramerAmount?, paintedParts?, changedParts? }`, price (BigInt, TL tam sayı), currency, contentHash, status (`ACTIVE`/`REMOVED`), firstSeenAt, lastSeenAt, removedAt?, relistedAt?, latestAnalysisId?.
  - İndeksler: (make, model, year); (status, firstSeenAt); (make, model, fuel, transmission, year, km).
- **ListingPriceHistory**: id, listingId, price, km, observedAt. Yalnızca değişiklikte yazılır.
- **ListingIssue**: id, sourceId, listingId?, externalId?, field, problem, rawSnippet, createdAt.
- **ListingAnalysis**: id, listingId, engineVersion, estimatedPrice, priceDiff, discountPct (decimal), opportunityScore (0–100), comparableCount, confidence (`HIGH`/`MEDIUM`/`LOW`/`INSUFFICIENT`), expansionLevel, flags[] (`DAMAGED`/`SUSPICIOUS_LOW`/`HIGH_DISPERSION`), explanation JSON, comparableIds int[], createdAt. Geçmiş korunur.

### Kullanıcı tarafı
- **SearchProfile**: id, userId, name, status (`ACTIVE`/`PAUSED`), make?, model?, yearMin?, yearMax?, priceMin?, priceMax?, kmMax?, fuels[], transmissions[], cities[], minDiscountPct (varsayılan 0), minConfidence (varsayılan `MEDIUM`), excludeDamaged, notifyOnPriceDrop, priceDropPct (varsayılan 5), notifyOnRelist, channels[] (`IN_APP` daima dahil), createdAt, updatedAt. İndeks (status, make, model).
- **ListingMatch**: id, userId, searchProfileId, listingId, analysisId, reason (`NEW`/`PRICE_DROP`/`RELIST`), matchedPrice, createdAt. **unique(searchProfileId, listingId, reason, matchedPrice)**.
- **Notification**: id, userId, matchId? (sistem alarmlarında null), kind (`MATCH`/`SYSTEM_ALERT`/`SECURITY`), channel, status (`PENDING`/`SENT`/`FAILED`/`SKIPPED_LIMIT`), attempts, lastError, payload JSON (anlık görüntü), sentAt, readAt, latencyMs, createdAt. **unique(matchId, channel)**.
- **Favorite**: userId, listingId, note?, createdAt. unique(userId, listingId).

### Sistem
- **AuditLog**: id, actorId, action, targetType, targetId, before JSON, after JSON, ip, createdAt.
- **SystemLog**: id, level, component, message, context JSON, createdAt. (Yalnızca warn+.)
- **SystemSetting**: key, value JSON (analiz katsayıları, alarm eşikleri, bakım modu vb.).
- **MakeModelAlias**: rawText, make, model, trim? — normalizer eşleme tablosu.

---

## 3. Scraper / Adapter Katmanı

### Adapter sözleşmesi
```ts
interface SourceAdapter {
  key: string;
  kind: 'HTTP' | 'BROWSER' | 'API' | 'FEED';
  listPages(ctx: AdapterContext): AsyncIterable<ListPage>;
  parseList(page: ListPage): RawListingRef[];
  fetchDetail?(ref: RawListingRef, ctx: AdapterContext): Promise<RawListing>;
}
interface AdapterContext {
  http: PoliteHttpClient;
  browser?: BrowserPool;
  config: SourceConfig;
  signal: AbortSignal;
  log: Logger;
}
```
Adapter'lar `adapterKey → class` registry'sine kaydedilir. Yeni kaynak = yeni dosya + bir registry satırı; mevcut kod değişmez.

### PoliteHttpClient (undici)
- Tüm ağ erişiminin tek giriş noktası.
- Kaynak bazlı Redis token-bucket (`minRequestGapMs`, `maxConcurrency`), tüm worker'lar arasında global.
- robots.txt kontrolü (24 saat önbellek); disallow → `ScrapeError(BLOCKED, transient=false)`.
- Dürüst User-Agent: `OtoFirsatBot/1.0 (+<iletişim-url>)`.
- Timeout: bağlantı 10 sn, toplam 30 sn. Gzip, ETag, If-Modified-Since.
- Proxy: kaynakta `proxyConfigId` varsa sabit ProxyAgent. Rotasyon yok.

### Hata sınıflandırması
| Durum | Sınıf | Davranış |
|---|---|---|
| Ağ hatası, timeout, 5xx, 429 (`Retry-After`'a uyulur) | geçici | Üstel backoff, 3 deneme |
| 403, captcha sayfası tespiti, robots disallow | `BLOCKED` kalıcı | Kaynak `PAUSED`, admin alarmı, yeniden deneme yok |
| Detay 404 | normal | İlan kaldırıldı adayı |
| Parse / validasyon hatası | `PARSE`/`VALIDATION` | İlan atlanır, `ListingIssue`; job içi oran > %20 → "sayfa yapısı değişmiş olabilir" alarmı, kaynak `DEGRADED` |

**Sağlık:** `consecutiveFailures` ≥ 3 → `DEGRADED`; ≥ 6 → `DOWN` + `SystemLog` + admin bildirimi; başarılı job → `HEALTHY`.

### Normalizer
- `MakeModelAlias` tablosuyla marka/model/trim eşleme.
- Yakıt/vites enum eşlemesi; "1.250.000 TL", "85.000 km" metin ayrıştırma.
- Validasyon: 1980 ≤ yıl ≤ bu yıl + 1; 0 ≤ km ≤ 1.500.000; 50.000 ≤ fiyat ≤ 50.000.000 TL.
- `contentHash` = normalize alanların hash'i (değişiklik tespiti).

### Browser scraper
Playwright yalnızca `kind=BROWSER` kaynaklarda, lazy başlatılır; worker başına en fazla 2 context. Stealth yok. MVP'de üretim kaynağı yok; iskelet demo-site'ın JS ile yüklenen bir sayfasıyla test edilir. Chromium yalnızca `WITH_BROWSER=true` build argümanıyla imaja eklenir.

### Manuel test taraması
Admin butonu → `CollectionJob(trigger=MANUAL, dryRun?)` kuyruğa girer; UI bloke olmaz; durum admin SSE akışıyla canlı izlenir. `dryRun` modunda parse sonuçları gösterilir, DB'ye yazılmaz.

### Demo site
Express + EJS; seed ile ~2000 gerçekçi ilan (marka/model/yıl/km'ye bağlı fiyat eğrisi), sayfalama, detay sayfası, bir JS-render sayfası. Zaman simülatörü dakikada bir: yeni ilan ekler, rastgele fiyat düşürür, ilan siler/yeniden yayınlar, %3 oranında %15–30 piyasa altı fırsat ilanı üretir. `/broken` modu bozuk HTML döndürür. Test/geliştirme için `POST /__inject` ile belirli ilan enjekte edilir. DataSource kaydı `permissionType=TEST`.

---

## 4. Fırsat Analiz Motoru (`rules-v1`)

`packages/analysis` — saf TypeScript, DB bağımsız. Girdi: hedef ilan + aday emsaller + ayarlar. Çıktı: analiz + açıklama.

### 4.1 Emsal havuzu (kademeli)
Taban: aynı make + model + fuel + transmission; hedefin kendisi hariç; son 60 günde görülmüş ilanlar (`REMOVED` olanlar son fiyatlarıyla dahil). Aynı başlık+fiyat+km mükerrer ilanlar tek sayılır.

| Seviye | Yıl | Km | Trim | Güven tavanı |
|---|---|---|---|---|
| L0 | ±0 | ±%25 | aynı (varsa) | HIGH |
| L1 | ±1 | ±%25 | serbest | HIGH |
| L2 | ±2 | ±%40 | serbest | MEDIUM |
| L3 | ±3 | ±%60 | serbest | LOW |

≥ 5 emsal bulunan ilk seviyede durulur. L3'te < 5 → `INSUFFICIENT`: tahmin gösterilir ama fırsat iddiası yapılmaz ve `minDiscountPct > 0` olan profillerle eşleşmez.

### 4.2 Düzeltmeler
- **Yıl:** yıl farkı başına %7 (`SystemSetting: analysis.yearAdjPct`).
- **Km:** havuz ≥ 8 ise Theil–Sen eğimi (fiyat ~ km); aksi halde 10.000 km başına %2. Toplam düzeltme ±%20 ile sınırlı.
- **Hasar:** hedef hasarsızsa hasarlı emsaller (yeterli emsal kalıyorsa) çıkarılır. Hedef hasarlıysa `DAMAGED` bayrağı + güven bir kademe düşer; fiyat düzeltmesi yapılmaz, kullanıcıya açık uyarı gösterilir.

### 4.3 Tahmin
Düzeltilmiş fiyatlarda IQR ayıklama (Q1 − 1.5·IQR, Q3 + 1.5·IQR); kalanların **medyanı** = `estimatedPrice`.
`priceDiff = estimated − price`; `discountPct = priceDiff / estimated`.

### 4.4 Güvenilirlik
Seviye tavanından başlar, sonra:
- Emsal sayısı 5–7 → en fazla MEDIUM.
- Yayılım (IQR / medyan) > %25 → bir kademe düş, `HIGH_DISPERSION`.
- `DAMAGED` → bir kademe düş.
- `discountPct` > %45 → `SUSPICIOUS_LOW` (olası hatalı/dolandırıcılık ilanı), güven en fazla LOW.

### 4.5 Fırsat puanı
```
score = clamp(discountPct / 0.30, 0, 1) × 70
      + {HIGH: 30, MEDIUM: 18, LOW: 6, INSUFFICIENT: 0}[confidence]
      + (ilanın geçmişinde fiyat düşüşü varsa 5)
score = clamp(round(score), 0, 100)
```
discountPct ≤ 0 ise ilk terim 0'dır. Puan, indirim ve güven ayrı alanlarda saklanır.

### 4.6 Açıklanabilirlik
`explanation`: seviye, ham/ayıklanmış havuz büyüklüğü, çıkarılan uç değerler, yıl/km düzeltme oranları ve yöntemi (Theil–Sen/varsayılan), Q1/medyan/Q3, bayraklar, kullanılan ayar değerleri. `comparableIds` saklanır. UI "Bu fiyat nasıl hesaplandı?" panelini bunlardan üretir (emsal tablosu + fiyat×km dağılım grafiği).

### 4.7 Yeniden analiz
- Fiyat değişiminde anında.
- Gece görevi tüm ACTIVE ilanları yeniden analiz eder; tahmin %2'den fazla değiştiyse yeni satır yazılır. Gece analizi **bildirim üretmez**.

### 4.8 Referans örnek (test vakası)
Emsal medyanı 1.200.000, ilan 960.000 → fark 240.000, indirim %20; 14 emsal, L1, yayılım %12 → HIGH; puan = round(0.6667×70 + 30) = **77**. Kullanıcı eşiği %15 → eşleşir.

---

## 5. Eşleştirme ve Bildirim

### 5.1 Tetikleyiciler
- `NEW`: ilk görülme → tüm aktif profiller aday.
- `PRICE_DROP`: yalnızca `notifyOnPriceDrop=true` profiller; düşüş, bu profile bu ilan için gönderilen **son bildirimdeki fiyata** göre ≥ `priceDropPct` olmalı. Profile daha önce bildirilmemiş ilan fiyat düşüşüyle eşiklere girerse `NEW` gibi davranılır.
- `RELIST`: `REMOVED` → tekrar görüldü (aynı externalId; veya aynı kaynak + başlık + km + yıl ve 7 gün içinde yeni externalId). Yalnızca `notifyOnRelist=true` profiller.

### 5.2 Eşleştirme sorgusu
İlan değerleri parametre olarak tek SQL'de profillere karşı test edilir:
```sql
SELECT sp.* FROM "SearchProfile" sp JOIN "User" u ON u.id = sp."userId"
WHERE sp.status='ACTIVE' AND u.status='ACTIVE'
  AND (sp.make IS NULL OR sp.make = $make)
  AND (sp.model IS NULL OR sp.model = $model)
  AND (sp."yearMin" IS NULL OR $year >= sp."yearMin")
  AND (sp."yearMax" IS NULL OR $year <= sp."yearMax")
  AND (sp."priceMin" IS NULL OR $price >= sp."priceMin")
  AND (sp."priceMax" IS NULL OR $price <= sp."priceMax")
  AND (sp."kmMax" IS NULL OR $km <= sp."kmMax")
  AND (cardinality(sp.fuels)=0 OR $fuel = ANY(sp.fuels))
  AND (cardinality(sp.transmissions)=0 OR $transmission = ANY(sp.transmissions))
  AND (cardinality(sp.cities)=0 OR $city = ANY(sp.cities))
  AND (sp."excludeDamaged"=false OR $damaged=false)
  AND (
        sp."minDiscountPct" = 0
     OR ( $confidence <> 'INSUFFICIENT'
          AND $discountPct >= sp."minDiscountPct"
          AND confidence_rank($confidence) >= confidence_rank(sp."minConfidence") )
  )
```
`confidence_rank` immutable bir SQL fonksiyonudur (INSUFFICIENT=0, LOW=1, MEDIUM=2, HIGH=3). Eşik 0 olan profiller "yeni ilan takibi" gibi çalışır; güven koşulu uygulanmaz.

### 5.3 Eşleşme sonrası
1. `ListingMatch` — `INSERT … ON CONFLICT DO NOTHING`; çakışmada dur (1. koruma).
2. Sunucu tarafı limit: kullanıcının günlük bildirim sayacı (Redis `INCR` + gece yarısı TTL, DB ile mutabakat). Aşılırsa harici kanallar için `Notification(SKIPPED_LIMIT)`; in-app kaydı yine oluşur ve "Limit aşıldı" etiketi taşır.
3. Profil kanallarının her biri için `Notification(PENDING)` — unique(matchId, channel) (2. koruma) — ve `notify` job'u (jobId = notificationId).

### 5.4 Kanal adapter'ları
```ts
interface NotificationChannelAdapter {
  type: 'IN_APP' | 'TELEGRAM' | 'EMAIL';
  send(n: NotificationPayload, cfg: ChannelConfig): Promise<SendResult>; // SENT | RETRYABLE(err) | PERMANENT(err)
}
```
- **IN_APP:** Kayıt DB'de; gönderim = Redis pub/sub `user:{id}` yayını → API SSE (`/api/v1/me/notifications/stream`) → zil sayacı canlı güncellenir, toast (+ opsiyonel ses). Çevrimdışıyken kayıt bekler.
- **TELEGRAM:** Bot API'ye HTTPS; görsel varsa `sendPhoto`, yoksa `sendMessage` (HTML). Inline butonlar: "İlana git", "Favorile" (callback → Favorite), "Analizi gör". Limitler: global 25 msj/sn, chat başına 1 msj/sn (BullMQ limiter). 429 `retry_after` → geçici; 403 "bot was blocked" → kalıcı, kanal `isEnabled=false` + in-app uyarı.
- **EMAIL:** SMTP adapter iskeleti; MVP'de yalnızca doğrulama/şifre sıfırlama; ilan bildirimi kapalı.

### 5.5 Telegram mesaj şablonu
```
🔥 Fırsat · Skor 77 · Güven: Yüksek
BMW 3 Serisi 320i · 2019
💰 960.000 TL   (Piyasa ≈ 1.200.000 TL)
📉 240.000 TL altında · %20
🛣 85.000 km · Benzin · Otomatik · İstanbul
📊 14 benzer ilan ile karşılaştırıldı
🕒 İlk görülme: 10.10.2026 14:32
[İlana git]  [Favorile]  [Analizi gör]
Fiyat analizi tahminidir; aracın durumunu garanti etmez.
```
Fiyat düşüşü: başlık "📉 Fiyat düştü: 1.010.000 → 960.000". Yeniden yayın: "🔁 Yeniden yayında".

### 5.6 Yeniden deneme ve izleme
5 deneme, üstel bekleme (10 sn → 30 sn → 2 dk → 10 dk → 30 dk); sonra `FAILED` + `lastError`. Admin tekli/toplu yeniden kuyruğa alabilir (audit). Kullanıcı kendi gönderilen/başarısız geçmişini görür. `latencyMs = sentAt − listing.firstSeenAt` saklanır; admin p50/p95 görür.

### 5.7 Telegram bağlama
Ayarlar → "Telegram'ı bağla" → 10 dk'lık tek kullanımlık kod + `t.me/<bot>?start=<kod>`. Bot kodu doğrular, chatId'yi şifreli kaydeder, `isVerified=true`; Telegram'da ve panelde onay. Webhook `X-Telegram-Bot-Api-Secret-Token` ile doğrulanır. `TELEGRAM_MODE=polling` (dev) | `webhook` (prod).

---

## 6. Kimlik Doğrulama, Güvenlik, İzolasyon

### Topoloji
Caddy tek origin: `/` → web, `/api/*` → api. First-party cookie, CORS yok. Prod'da otomatik HTTPS.

### Oturum
- Access JWT (EdDSA), 15 dk, httpOnly + Secure + SameSite=Lax cookie. Claim: `sub`, `role`, `sid`.
- Refresh token: 32 byte rastgele, `/api/v1/auth/refresh` path'li cookie, 30 gün; DB'de hash. Rotasyon + **yeniden kullanım tespiti**: eski token kullanılırsa ilgili `familyId` zinciri iptal + güvenlik bildirimi.
- Askıya alma / şifre değişimi → tüm Session'lar revoke. Kritik admin uç noktaları oturumu DB'den canlı doğrular.
- CSRF: SameSite=Lax + mutasyonlarda zorunlu `X-Requested-With` + Origin kontrolü.
- "Oturumlarım" ekranı: diğer oturumları kapatma.

### Kayıt ve şifre
- argon2id (64 MB, t=3); min 10 karakter; HIBP k-anonymity kontrolü (erişilemezse atlanır).
- E-posta doğrulama; doğrulanmamış hesap: Telegram bağlayamaz, en fazla 1 profil.
- Şifre sıfırlama: tek kullanımlık hash'li token, 30 dk; yanıt her durumda aynı (enumeration yok). Dev'de Mailpit.
- Giriş koruması: IP+e-posta başına 15 dk'da 5 hatalı → artan gecikme + güvenlik logu.

### Yetkilendirme
- Global `JwtAuthGuard` + `RolesGuard`; varsayılan kapalı, `@Public()` ile açılır.
- `/admin/*` → `ADMIN | SUPER_ADMIN`. Rol değiştirme, kullanıcı silme, plan ve sistem ayarları → yalnızca `SUPER_ADMIN`.
- Son süper admin silinemez/düşürülemez. Frontend rol kontrolü yalnızca görünürlük içindir.

### İzolasyon (3 katman)
1. `UserScopedRepository`: tüm kullanıcı sorgularına `userId` eklenir; `findFirst({ where: { id, userId } })`. Yabancı kaynak → **404**.
2. ESLint `no-restricted-syntax`: `apps/api/src/modules/me/**` altında doğrudan `prisma.` yasak.
3. E2E izolasyon matrisi: kullanıcı A ve B; B, A'nın her kaynağında okuma/güncelleme/silme dener. Route listesi `/me/*` controller metadata'sından otomatik çıkarılır; matriste kapsanmayan route testi düşürür.

### Girdi ve API sertleştirme
- Global zod validasyon (şemalar `packages/shared`; frontend formları aynı şemalar); bilinmeyen alanlar reddedilir.
- Rate limit (`@nestjs/throttler` + Redis): genel 120/dk/kullanıcı; auth 10/dk/IP; manuel tarama 1/dk/kaynak.
- Helmet; Next tarafında nonce'lu CSP. Hata yanıtında stack yok.
- Sayfalama limiti ≤ 100; sıralama alanları whitelist.

### Gizli veriler
- Env: `DATABASE_URL`, `REDIS_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `DATA_ENCRYPTION_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_MODE`, `SMTP_*`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `PUBLIC_BASE_URL`, `SENTRY_DSN?`. Açılışta zod ile doğrulanır; eksikse süreç başlamaz.
- Şifreli alanlar AES-256-GCM, biçim `v1:iv:tag:ct` (anahtar rotasyonuna hazır).
- Pino redaction: `password`, `token`, `authorization`, `cookie`, `proxy*`, `chatId`, `config`.
- API yanıtları bu alanları döndürmez; proxy `http://***@host:port` olarak gösterilir.

### Denetim
`AuditInterceptor` admin mutasyonlarını yazar (aktör, aksiyon, hedef, before/after, IP). Güvenlik olayları: hatalı giriş serisi, token yeniden kullanımı, rol değişimi, şifre sıfırlama. Admin "Denetim Kayıtları" ekranı.

### KVKK ve saklama
Kayıtta aydınlatma metni onayı. Hesap silme: soft delete + anonimleştirme (`deleted+<id>@invalid`), profiller/kanallar/favoriler silinir; bildirimler 90 gün sonra temizlenir. `SystemLog` ve `ScrapeError` 30 gün; `AuditLog` 1 yıl.

### Yedekleme
`backup` servisi: gecelik `pg_dump -Fc`, 7 günlük + 4 haftalık rotasyon; opsiyonel S3 uyumlu hedef. `docs/operations/backup-restore.md` + `scripts/restore-test.sh` (geçici DB'ye açıp doğrular; ayda bir önerilir).

### Ertelenenler
Admin TOTP 2FA (Aşama 3), OAuth girişi, cihaz parmak izi.

---

## 7. API Sözleşmeleri

**Kurallar:** base `/api/v1`; JSON camelCase; tarihler ISO-8601 UTC (UI'da Europe/Istanbul); para tam sayı TL, JSON'da string. Liste: cursor `{ items, nextCursor }`; admin tabloları offset `{ items, total }`. Hata: `{ error: { code, message, details? } }` (kodlar `packages/shared/errors.ts`). Sözleşme kaynağı zod şemaları; OpenAPI `nestjs-zod` ile üretilir, `/api/docs` (prod'da yalnızca admin).

### Auth (`@Public`)
```
POST /auth/register         {email,password,name,kvkkAccepted}
POST /auth/login            {email,password}           → cookie, {user}
POST /auth/refresh                                     → cookie rotasyonu
POST /auth/logout
POST /auth/verify-email     {token}
POST /auth/forgot-password  {email}                    → her zaman 204
POST /auth/reset-password   {token,newPassword}
```

### Kullanıcı (`/me/*`, userId kapsamlı)
```
GET    /me                                profil + plan + kullanım özeti
PATCH  /me                                {name}
POST   /me/change-password
GET    /me/sessions · DELETE /me/sessions/:id
DELETE /me                                hesap silme (şifre onayı)
GET    /me/dashboard                      son fırsatlar, aktif profiller, bugünkü bildirim/limit, 7 günlük eşleşme serisi
GET    /me/search-profiles · POST /me/search-profiles
GET    /me/search-profiles/:id · PATCH · DELETE
POST   /me/search-profiles/:id/pause · /resume
POST   /me/search-profiles/preview        {filtre} → son 20 eşleşecek ilan + tahmini günlük eşleşme
GET    /me/matches                        ?profileId&reason&minScore&confidence&sort&cursor
GET    /me/opportunities                  sistem geneli güncel fırsatlar (skor ≥ 60, güven ≥ MEDIUM)
GET    /me/listings/:id                   ilan + son analiz + fiyat geçmişi + emsaller
GET    /me/favorites · PUT /me/favorites/:listingId {note?} · DELETE /me/favorites/:listingId
GET    /me/notifications                  ?status&channel&unread&cursor
POST   /me/notifications/read             {ids[]} | {all:true}
GET    /me/notifications/stream           SSE
GET    /me/channels
POST   /me/channels/telegram/link         → {deepLink, expiresAt}
PATCH  /me/channels/:type                 {isEnabled}
DELETE /me/channels/telegram
GET    /me/subscription                   plan, limitler, kullanım
GET    /catalog/makes · /catalog/makes/:make/models
```
İlan verisi merkezi ve kişisel olmadığından okunabilir; eşleşme, favori, bildirim ve profil verileri kişiseldir. `opportunitiesDelayHours` plan alanı MVP'de 0'dır (Aşama 3'te devreye girer).

### Admin (`/admin/*`)
```
GET   /admin/overview
GET   /admin/users ?q&status&role&plan&page · GET /admin/users/:id · PATCH /admin/users/:id
POST  /admin/users/:id/suspend · /activate · DELETE /admin/users/:id      (silme: SUPER_ADMIN)
PATCH /admin/users/:id/role                                              (SUPER_ADMIN)
GET   /admin/users/:id/search-profiles · /notifications · /usage
PATCH /admin/users/:id/subscription  {planId, endsAt, limitOverrides}
GET   /admin/listings ?source&make&model&status&hasIssues · GET /admin/listings/:id
GET   /admin/listing-issues
GET   /admin/analyses ?confidence&minScore · POST /admin/listings/:id/reanalyze
GET   /admin/sources · POST /admin/sources · PATCH /admin/sources/:id
POST  /admin/sources/:id/activate · /pause
POST  /admin/sources/:id/test-scrape {dryRun} → {jobId}
GET   /admin/sources/:id/stats ?range
GET   /admin/jobs ?source&status · GET /admin/jobs/:id
GET   /admin/proxies · POST · PATCH /admin/proxies/:id · POST /admin/proxies/:id/check
GET   /admin/queues · POST /admin/queues/:name/retry-failed · /clean
GET   /admin/workers
GET   /admin/notifications ?status&channel · POST /admin/notifications/retry {ids[]}
GET   /admin/plans · POST · PATCH /admin/plans/:id                       (SUPER_ADMIN)
GET   /admin/settings · PATCH /admin/settings                            (SUPER_ADMIN)
GET   /admin/audit-logs · GET /admin/system-logs
GET   /admin/stream                       SSE: job durumu, alarmlar, KPI
POST  /telegram/webhook                   @Public + secret header
GET   /health/live · /health/ready
```

---

## 8. Paneller ve Görsel Tasarım

### Sayfalar
**Kullanıcı (`/app`):** Dashboard · Fırsatlar (kart/tablo, filtreler) · Arama Profillerim (liste + canlı önizlemeli sihirbaz) · İlan Detayı (galeri, fiyat geçmişi grafiği, "Fiyat nasıl hesaplandı?" paneli) · Favoriler · Bildirimler (zil + sayfa) · Abonelik · Ayarlar (hesap, güvenlik, oturumlar, bildirim kanalları).

**Admin (`/admin`):** Genel Bakış · Kullanıcılar · İlanlar (+ hatalı kayıtlar) · Fırsat Analizi · Scraper Yönetimi (kaynak kartları, işler, hatalar, proxy, test taraması) · Sistem İzleme (kuyruklar, worker'lar, gecikme, bildirim hataları) · Paketler · Ayarlar · Denetim Kayıtları.

Teknik: Next.js App Router, RSC + TanStack Query, typed client (zod şemalarından). Mobilde sidebar → drawer, tablolar → kart listesi.

### Görsel yön: "Gece Showroom"
- Koyu öncelikli; açık tema tam destekli, sistem tercihine uyar.
- Zemin grafit `#0E0F11`, yüzeyler bir kademe açık, 1px ince kenarlık, gölge yerine katman tonları.
- Vurgu bakır/amber `#E8A35C` — yalnızca fırsat, skor ve birincil aksiyonlar. Pozitif: sakin yeşil; uyarı: kırmızı.
- Tipografi: başlık **Instrument Sans**, gövde **Inter**, sayılar/fiyat **Geist Mono** (tabular). Türkçe glif desteği tam.
- Hareket: yeni fırsat kartı tek seferlik yumuşak amber parıltıyla girer; zil sayacı sayarak artar; `prefers-reduced-motion` desteklenir.
- Stack: Tailwind v4, shadcn/ui (Radix), Lucide, Recharts, Framer Motion (ölçülü), sonner.
- Erişilebilirlik: AA kontrast, tam klavye gezinmesi, renge ek olarak metin etiketleri.

### İmza bileşenleri
- **Fiyat bandı:** yatay şerit; Q1–medyan–Q3 ve ilan fiyatı işaretçisi. Kart, detay ve "Analizi gör" sayfasında aynı bileşen.
- **Skor halkası** (0–100) ve **4 segmentli güven göstergesi** + metin ("Yüksek güven · 14 emsal").
- Fiyat biçimi `960.000 ₺`; indirim yüzdesi fiyatın yanında.

```
┌──────────────────────────────────────────────┐
│ [foto]  BMW 3 Serisi 320i · 2019      ◔ 77   │
│         85.000 km · Benzin · Otomatik        │
│         960.000 ₺   %20 altında  ▮▮▮▯ Yüksek │
│  ├──────[Q1]━━━━[medyan 1.2M]━━━━[Q3]──┤     │
│     ▲ bu ilan                                │
│  14 emsal · 12 dk önce · İstanbul   ♡  ↗     │
└──────────────────────────────────────────────┘
```

---

## 9. Hata Yönetimi ve İzleme

- API `AllExceptionsFilter` → standart hata formatı; beklenmeyen hata 500 + `requestId`.
- Correlation: `requestId` / `jobId` AsyncLocalStorage ile tüm Pino satırlarına eklenir; ilanın scrape → bildirim yolculuğu izlenebilir.
- Worker `JobError`: `transient` → BullMQ retry; `permanent` → `UnrecoverableError`. Başarısız job'lar 7 gün saklanır, adminden yeniden denenir.
- Graceful shutdown: SIGTERM → yeni job alma, aktifleri 30 sn bekle, Playwright context'lerini kapat.
- Loglar: Pino JSON → stdout; warn+ ayrıca `SystemLog`.
- Metrikler panelde DB/Redis'ten hesaplanır: kuyruk derinliği, throughput, hata oranı, gecikme p50/p95, kaynak başına ilan/gün, worker heartbeat. İleride `prom-client` + Grafana eklenebilir.
- Sentry opsiyonel (`SENTRY_DSN`).
- Alarmlar: kaynak DOWN/PAUSED, parser hata oranı, kuyruk derinliği (notify > 500), bildirim hata oranı > %10, worker heartbeat kaybı → `SystemLog(ERROR)` + adminlere in-app (+ bağlıysa Telegram). Aynı alarm için 30 dk susturma.
- Health: `/health/live` (process), `/health/ready` (DB, Redis, migration). Docker healthcheck'leri bunlara bağlı.

---

## 10. Test Stratejisi

| Katman | Araç | Kapsam |
|---|---|---|
| Birim | Vitest | Analiz motoru (§4.8 referans örneği, yetersiz emsal, uç değer, km düzeltme, hasar, şüpheli ucuz), normalizer, fiyat ayrıştırma, skor, eşleştirme predicate'i, şifreleme |
| Adapter | Vitest + HTML fixture | Demo-site parser; bozuk HTML parse hata yolu |
| Entegrasyon | Vitest + Testcontainers (Postgres, Redis) | Ingest idempotency (aynı ilan 2× → 1 satır), fiyat değişimi → history + PRICE_DROP, Match/Notification unique'leri, limit aşımı, retry sınıflandırması, kaynak sağlık geçişleri |
| API e2e | Supertest | Auth akışları, refresh rotasyonu + yeniden kullanım tespiti, RBAC (USER → /admin = 403), izolasyon matrisi |
| Telegram | msw sahte Bot API | Mesaj formatı, 429 retry_after, 403 kanal kapatma |
| Uçtan uca | Playwright | Kayıt → profil → demo-site'a fırsat enjekte → panelde canlı bildirim → sahte Telegram'a mesaj → admin panelinde job ve bildirim görünür |
| Bileşen | Vitest + Testing Library | Fiyat bandı, skor halkası, profil formu |

Geliştirme TDD ile yapılır. GitHub Actions: lint + typecheck + test.

---

## 11. Dağıtım ve Dokümantasyon

- `docker-compose.yml` (prod): caddy, web, api, worker (×N), scheduler, postgres, redis, migrate, backup.
- `docker-compose.dev.yml`: hot reload, mailpit, demo-site, Telegram polling.
- Multi-stage Dockerfile'lar (pnpm deploy, non-root). Worker'da Chromium yalnızca `WITH_BROWSER=true`.
- Seed: planlar (FREE / PRO / BUSINESS limitleri), ilk süper admin (env), demo-site DataSource + `MakeModelAlias` (dev).
- Dokümanlar: `README.md` (hızlı kurulum), `docs/architecture.md`, `docs/analysis-engine.md`, `docs/adding-a-source.md` (adapter rehberi + izin checklist'i), `docs/operations/` (deploy, backup-restore, alarmlar, Telegram bot kurulumu), `.env.example` (açıklamalı).

**Başlangıç plan limitleri (seed, admin değiştirebilir):**

| Plan | maxSearchProfiles | maxNotificationsPerDay | Kanallar |
|---|---|---|---|
| FREE | 2 | 20 | IN_APP, TELEGRAM |
| PRO | 10 | 200 | IN_APP, TELEGRAM, EMAIL |
| BUSINESS | 50 | 2000 | IN_APP, TELEGRAM, EMAIL |

---

## 12. Uygulama Dilimleri

1. Monorepo iskeleti, Docker dev ortamı, Prisma şeması, CI.
2. Auth + kullanıcı/rol + izolasyon altyapısı + e2e testleri.
3. Demo-site + adapter çerçevesi + PoliteHttpClient + ingest/dedup.
4. Analiz motoru.
5. Arama profilleri + eşleştirme.
6. Bildirim: in-app/SSE + Telegram.
7. Web tasarım sistemi + kullanıcı paneli.
8. Admin paneli (genel bakış, kullanıcılar, ilanlar, scraper yönetimi, izleme, paketler, denetim).
9. Uçtan uca test, prod compose, dokümantasyon.

Her dilim sonunda sistem çalışır ve testleri geçer.

---

## 13. Kapsam Dışı (bu spec)

Ödeme entegrasyonu, plan satın alma akışı, admin 2FA, OAuth, e-posta/web-push ilan bildirimleri, çoklu gerçek kaynak, istatistiksel/ML fiyat modelleri, AI açıklamaları, Sahibinden/Arabam adapter'ları (yazılı izin/lisans gelene kadar).
