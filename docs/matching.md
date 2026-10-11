# Arama profilleri ve eşleştirme (Plan 04)

Bir analiz olayı (`NEW`, `PRICE_DROP`, `RELIST`) `match` kuyruğuna düşer; worker ilanı kullanıcıların ACTIVE arama profilleriyle eşleştirir ve her uygun profil için bir `ListingMatch` yazar. Kullanıcı sonuçları `GET /me/matches` ile görür. Bildirim üretimi ve teslimi: [notifications.md](notifications.md).

## Tek eşleştirme koşulu: `matchPredicate`

`packages/db/src/matching.ts` içindeki `matchPredicate(profileSide, listingSide)` koşulun TEK tanımıdır; iki yönde kullanılır:

| Yön | Kim | Profil tarafı | İlan tarafı |
|---|---|---|---|
| "Bu ilana uyan profiller" | worker (`findMatchingProfiles`) | `SearchProfile` sütunları | ilan/analiz değerleri (bağlı parametre) |
| "Bu filtreye uyan ilanlar" | API önizleme (`previewListings`, `countPreviewSince`) | filtre değerleri (bağlı parametre) | `Listing` + `latestAnalysisId` analizi sütunları |

Koşul (hepsi `AND`; boş/`NULL` alan "fark etmez" demektir): make, model (`fold_tr` ile), yıl aralığı, fiyat aralığı, `kmMax`, yakıt ve vites listeleri, şehirler (`fold_tr`), `excludeDamaged` (ilan analiz bayraklarında `'DAMAGED'` yoksa) ve indirim/güven koşulu:

- `minDiscountPct = 0` → "yeni ilan takibi": güven ve indirim koşulu uygulanmaz (`INSUFFICIENT` ilan da eşleşir).
- `minDiscountPct > 0` → ilan `INSUFFICIENT` olmamalı, `discountPct >= minDiscountPct` ve `confidence_rank(ilan) >= confidence_rank(profil.minConfidence)` olmalı.

Bütün ifade `IS TRUE` ile sarılıdır; `NULL` sonuç eşleşme sayılmaz. Parite e2e testi iki yönün aynı sonucu verdiğini kanıtlar; önizleme ile gerçek eşleşme bu yüzden sapmaz.

### `fold_tr` ve `confidence_rank`

Migration `20261013000000_matching_functions` iki IMMUTABLE SQL fonksiyonu ekler:

- `fold_tr(t)` = `lower(translate(t, 'İIıĞğÜüŞşÖöÇç', 'iiigguussoocc'))`. Postgres `lower()` locale'e bağlı olduğundan Türkçe harfler önce ASCII'ye katlanır: "İstanbul" = "istanbul" = "ISTANBUL", "Şahin" = "sahin".
  **Sınırlar:** yalnızca bu Türkçe harfler katlanır. `â/î/û` gibi şapkalı harfler ve Türkçe dışı harfler (ör. `é`, `ß`) katlanmaz; bunların küçültülmesi veritabanı locale'ine bağlıdır.
- `confidence_rank(text)`: INSUFFICIENT 0, LOW 1, MEDIUM 2, HIGH 3 (bilinmeyen değer 0).

Migration `…0002` profil dizi sütunlarını `NOT NULL DEFAULT []` yapar; koşul ayrıca `coalesce(cardinality(...), 0)` ile `NULL` dizilere karşı da güvenlidir.

## Eşleşme fiyatı

Worker `analysis.listingPrice ?? listing.price` kullanır: olay hangi fiyattan doğduysa o fiyattan eşleşir ve `ListingMatch.matchedPrice` o fiyattır. İş verisi değil `ListingAnalysis` + `Listing` güncel durumu esas alınır; eski bir analiz işi yeniden gönderilse bile ilanın `latestAnalysisId` analizi değerlendirilir ve eşleşmeye o analizin id'si yazılır. İlan `REMOVED` ise eşleştirme yapılmaz (`SKIPPED`).

Önizleme ise ilanın GÜNCEL fiyatını (`Listing.price`) kullanır; worker analiz anındaki fiyatı. Aralarında fiyat değişmişse küçük fark olabilir (kabul edilmiş davranış).

## Profil başına neden: `decideMatchReason`

`decideMatchReason(event, profile, lastMatchedPrice, price)` saf fonksiyondur (`apps/worker/src/matching/decide.ts`):

| Durum | Sonuç |
|---|---|
| Profile bu ilan için hiç eşleşme yazılmamış (`lastMatchedPrice = null`), olay ne olursa olsun | `NEW` |
| Olay `RELIST` ve `notifyOnRelist` | `RELIST` |
| `notifyOnPriceDrop` ve `price <= lastMatchedPrice * (1 - priceDropPct)` | `PRICE_DROP` |
| Diğer | eşleşme yok |

Örnekler (`priceDropPct = 0.05`, son eşleşme 1.000.000 TL):

- İlk kez uyan ilan, olay `PRICE_DROP` → `NEW` (daha önce bildirilmemiş ilan NEW gibi davranır; Plan 03'ün yükseltme-NEW'i idempotent kalır).
- Olay `PRICE_DROP`, yeni fiyat 940.000 → `PRICE_DROP`; 970.000 → yok.
- Olay `RELIST`, `notifyOnRelist = true` → `RELIST`. `notifyOnRelist = false` ama fiyat en az %5 düşmüşse → `PRICE_DROP` (düşük fiyatlı RELIST, PRICE_DROP profillerini de besler).

"Son eşleşme fiyatı", profilin o ilan için yazılmış en son (id'ye göre) eşleşmesinin `matchedPrice` değeridir.

## Idempotentlik katmanları

1. **Advisory kilit:** her iş `pg_advisory_xact_lock(4242, listingId)` ile başlar; aynı ilanın eşzamanlı iki işi sıraya girer (iki-int anahtar uzayı, tek-bigint `hashtext` kilitleriyle çakışmaz). Transaction `maxWait` 10 sn, `timeout` 30 sn.
2. **Benzersiz anahtar:** `ListingMatch (searchProfileId, listingId, reason, matchedPrice)`; ekleme `ON CONFLICT DO NOTHING`. Yinelenen iş boş `created` döner.
3. **Son eşleşme kontrolü:** neden, profilin o ilan için son eşleşme fiyatına göre hesaplanır.

**Sırasız olay örneği:** `PRICE_DROP` işi `NEW` işinden önce işlenirse profil ilk eşleşmeyi `NEW` olarak (düşük fiyattan) alır; sonradan gelen eski `NEW` işi aynı fiyatta olduğundan tekrar eşleşme üretmez.

**Bilinen boşluklar (benzersiz anahtarın sonucu):** anahtar (neden, fiyat) çifti üzerinden olduğundan şu durumlar yeniden bildirim üretmez: (a) aynı fiyatla ikinci `RELIST` (ör. aylar sonra aynı fiyatla yeniden yayın); (b) `NEW` → `PRICE_DROP` 900k → `RELIST` 1M → `PRICE_DROP` 900k dizisinde son `PRICE_DROP`. Roadmap'te borç olarak izlenir.

## Profil limitleri (API)

Etkin limitler `LimitsService.forUser`: `effectiveLimits(plan.limits, subscription.limitOverrides)`. Aktif ve süresi dolmamış abonelik yoksa FREE planı geçerlidir.

- Oluşturma: toplam profil sayısı (ACTIVE + PAUSED) `maxSearchProfiles` altında olmalı; kullanıcı başına advisory kilit altında sayılır, böylece paralel iki istek limiti aşamaz (biri 201, diğeri 403 `LIMIT_REACHED`).
- **Doğrulanmamış e-posta:** en fazla 1 profil (`details.reason = 'EMAIL_NOT_VERIFIED'`; plan limiti için `'PLAN'`).
- **Sürdürme (`resume`):** ACTIVE sayısı limitin altında olmalı. Plan düşürülürse fazla ACTIVE profiller çalışmaya devam eder ama yeni sürdürme engellenir. Plan 07: admin abonelik değişimi ve süresi dolan abonelik süpürmesi fazlayı PAUSED yapar; paket limitlerini düşürmek ise mevcut profilleri korur (yanıtta `usersOverProfileLimit`, bkz. [admin.md](admin.md#paket-limitleri)).
- Kanallar: plan kanalları ∩ {IN_APP, TELEGRAM}; `IN_APP` daima eklenir; EMAIL ilan bildirimi MVP'de kapalı. Kanal kontrolü güncellemede yalnızca YENİ eklenen kanallar için yapılır.
- `PATCH` son yazan kazanır (okuma-birleştirme-yazma arasında kilit yok; MVP'de kabul edildi).
- `GET /me` aboneliği her zaman null olmayan döner; canlı abonelik yoksa FREE planı ve `status: 'FALLBACK'` ile.

## Önizleme (`POST /me/search-profiles/preview`)

Filtreye uyan, ACTIVE ve analizi olan ilanlardan en yeni 20'sini döner. `estimatedDailyMatches` = son 7 günde ilk görülen eşleşen ilan sayısı / 7 (1 ondalık). Yani "bu profil günde kabaca kaç ilan yakalardı" tahminidir; gerçek eşleşme sayısı fiyat düşüşü/yeniden yayın nedenleriyle farklı olabilir ve günlük bildirim limiti henüz uygulanmaz.

## `/me/matches`

Yalnızca kullanıcının kendi eşleşmeleri; en yeni önce (id azalan), cursor = son id, `{ items, nextCursor }`. `confidence` filtresi "en az bu güven" demektir; `minScore` de desteklenir. Skor sıralaması yok (Plan 06 ihtiyaç duyarsa).

## Gözlemler (canlı duman testi)

- `minDiscountPct = 0` ise `minConfidence` yok sayılır (spec §5.2): eşik 0 iken yalnızca güven dışı koşullar uygulanır. Arayüz bu durumda güven alanını gizlemeli/devre dışı bırakmalıdır.
- Yeni oluşturulan bir profil yalnızca oluşturulduktan SONRA analiz olayı tetiklenen ilanlar için bildirilir; zaten eşleşen mevcut ilanlar bildirilmez, önizleme (ve Plan 06 fırsatlar ekranı) üzerinden görünür.
- `IN_APP` kanalı plan kanal listesinden bağımsız her zaman izinlidir.

## Yeni externalId ile yeniden yayın

`IngestService.findRelistTwin`: kaynakta bilinmeyen bir externalId geldiğinde, aynı kaynakta son 7 günde `REMOVED` olmuş, başlık + km + yıl aynı olan bir ilan varsa onun externalId'si yenisiyle değiştirilir (compare-and-set: ikiz hâlâ `REMOVED` ve externalId değişmemişse) ve RELIST yolu izlenir (spec §5.1). Eşzamanlı aynı externalId için tek ilan oluşur. **Sınır:** sezgi, başlığı/km/yılı birebir aynı iki gerçekten farklı aracı (biri 7 günden kısa süre önce kaldırılmışsa) birleştirebilir; spec gereği kabul edilmiştir.

## Çalıştırma

`MatchWorkerHost` `ROLE=worker` süreçte `match` kuyruğunu `MATCH_CONCURRENCY` (varsayılan 4) paralellikle tüketir; bozuk payload `UnrecoverableError`dır. Her eşzamanlı iş bir transaction (bağlantı) tutar: `DATABASE_URL` içindeki `connection_limit`, `SCRAPE_CONCURRENCY + ANALYZE_CONCURRENCY + MATCH_CONCURRENCY` toplamından ve biraz payla büyük olmalıdır.

## Plan 05'e bırakılanlar

- Bildirim kaydı: `MatchService.process` dönüşündeki `created[]` için `Notification` satırları ve `notify` işleri. Eşleşme ile bildirim kaydı AYNI transaction'da oluşturulmalı (`Notification(PENDING)`, `ON CONFLICT (matchId, channel) DO NOTHING`); `notify` işi commit SONRASI eklenir (jobId = notificationId); eski PENDING satırlarını bir süpürme yeniden kuyruğa alır. Aksi halde worker eşleşmeyi yazıp bildirimden önce çökerse yeniden denenen iş `ON CONFLICT` nedeniyle boş `created` döner ve bildirim kaybolur.
- Günlük bildirim sayacı ve `SKIPPED_LIMIT`: karar transaction içinde (kullanıcı kilidi altında DB sayımı) verilmeli ya da Redis sayacı DB ile mutabık olmalı; commit'ten önce asla `INCR` yapılmamalı.
- Kanal doğrulaması: TELEGRAM yalnızca doğrulanmış ve etkin kanal varsa; doğrulanmamış hesap Telegram bağlayamaz.
- `latencyMs = sentAt − listing.firstSeenAt`.
