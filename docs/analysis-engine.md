# Fırsat analiz motoru (`rules-v1`)

Kod: `packages/analysis` (saf, DB'siz) + `apps/worker/src/analysis` (DB, kuyruk). Ayarlar `SystemSetting` anahtarı `analysis.settings` ile kısmen ezilebilir (geçersiz ayar → varsayılanlar + uyarı günlüğü). Ayarlar süreç başına en fazla 60 sn önbelleğe alınır.

Varsayılan ayarlar: `minComparables 5`, `yearAdjPct 0,07`, `kmAdjPer10k 0,02`, `maxAdjPct 0,2`, `theilSenMinPool 8`, `smallPoolMax 7`, `dispersionThreshold 0,25`, `suspiciousDiscount 0,45`, `poolWindowDays 60`, `refreshMinChangePct 0,02`.

## 1. Emsal havuzu
Aynı marka + model + yakıt + vites; hedef hariç; son 60 günde görülmüş (`lastSeenAt`); kaldırılmışsa yalnızca son 60 günde kaldırılmış (son fiyatıyla). Sorgu hedef yılın ±3'ü ile sınırlıdır ve en fazla 1000 aday çeker. Aynı başlık + fiyat + km tek sayılır (en küçük id kalır). Fiyatı <= 0 olan emsaller yok sayılır (`explanation.pool.invalidPrice`).

| Seviye | Yıl | Km (× max(hedef km, 10.000)) | Trim | Güven tavanı |
|---|---|---|---|---|
| L0 | ±0 | ±%25 | aynı (hedefte varsa) | HIGH |
| L1 | ±1 | ±%25 | serbest | HIGH |
| L2 | ±2 | ±%40 | serbest | MEDIUM |
| L3 | ±3 | ±%60 | serbest | LOW |

Seviye seçimi: her seviyede havuz kurulur, düzeltilir ve uç değerler ayıklanır; **ayıklama sonrası kullanılabilir emsal sayısı >= 5** olan ilk seviyede durulur (ham aday sayısı değil).

Hasar politikası: hasar = `tramerAmount > 0` veya `changedParts` dolu (boyalı parça tek başına hasar sayılmaz).
- Hedef hasarsızsa önce **tüm seviyelerde yalnızca hasarsız emsallerle** denenir; hiçbir seviye yeterli olmazsa hasarlı emsaller de dahil edilerek seviyeler yeniden denenir. Yani geniş seviyedeki temiz havuz, dar seviyedeki hasarlı içeren havuza tercih edilir.
- Hedef hasarlıysa tüm emsaller (hasarlı dahil) kullanılır.

## 2. Düzeltmeler
- Yıl: emsal fiyatı `(1 + 0,07)^(hedef yılı − emsal yılı)` ile çarpılır (bileşik).
- Km: havuz >= 8 ise Theil–Sen eğimi (yalnızca negatifse), değilse 10.000 km başına %2.
- Yıl + km toplam düzeltmesi emsalin kendi fiyatının %80–%120'si ile sınırlanır (`clamped`).

## 3. Tahmin
Düzeltilmiş değerlerde (en az 4 emsal varsa) IQR ile uç değer ayıklama: sınır genişliği `max(1,5·IQR, medyanın %5'i)` olup neredeyse özdeş değerler yüzünden emsal atılması önlenir. Alt sınır Q1 − genişlik, üst sınır Q3 + genişliktir. Kalanların medyanı = tahmin. İndirim = (tahmin − fiyat) / tahmin, [−99,9999; 0,9999] aralığına kırpılır.

## 4. Güven
Seviye tavanı → kullanılan emsal <= 7 ise en fazla MEDIUM (`smallPoolMax`) → IQR/medyan > 0,25 ise bir kademe düş (`HIGH_DISPERSION`) → hedef hasarlıysa bir kademe düş (`DAMAGED`) → indirim > %45 ise en fazla LOW (`SUSPICIOUS_LOW`). Hiçbir seviyede (ayıklama sonrası) >= 5 emsal yoksa `INSUFFICIENT`.

`explanation.insufficientReason`: `NONE`, `NO_LEVEL` (hiçbir seviyede yeterli aday yok), `AFTER_OUTLIERS` (aday vardı ama ayıklama sonrası yetersiz), `INVALID_TARGET` (hedef fiyatı <= 0; indirim `null`, puan 0). INSUFFICIENT sonuçlarda tahmin (varsa) zayıf bir göstergedir, fırsat iddiası değildir; arayüz bunu etiketlemelidir.

## 5. Puan
`round(clamp(indirim / 0,30, 0, 1) × 70 + güven puanı + fiyat düşüşü bonusu)`, 0–100; güven puanı HIGH 30 / MEDIUM 18 / LOW 6 / INSUFFICIENT 0; bonus 5 (geçmişte fiyat düşüşü varsa ve indirim > 0). **Tavan:** `INSUFFICIENT` veya `SUSPICIOUS_LOW` sonuçlar en fazla 50 puan alır (fırsat eşiği 60'ın altında); `DAMAGED` formülü değiştirmez (bayrak arayüzde görünür).

## 6. Örnek
14 emsal (L1, yayılım ~%10), medyan 1.200.000 TL, ilan 960.000 TL → fark 240.000, indirim %20, güven HIGH, puan `round(0,667 × 70 + 30) = 77`.

## 7. Olaylar
Analiz işi verisindeki `reason` yalnızca ipucudur. Olay son analizle karşılaştırılarak DB'den türetilir: ilk analiz `NEW`; son analizden sonra yeniden yayın (`relistedAt` > son analiz zamanı) `RELIST`; içerik özeti aynıysa `REFRESH`; fiyat son analiz edilen fiyattan düşükse `PRICE_DROP`; diğer değişiklik (fiyat artışı dahil) `CHANGE`. Yalnızca `NEW`, `PRICE_DROP`, `RELIST` → `match` kuyruğu (`jobId = match-<analysisId>`; `previousPrice` yalnızca `PRICE_DROP`'ta). `REFRESH` yeni satırı yalnızca tahmin > %2 değiştiğinde (veya güven/motor sürümü değiştiğinde) yazar ve olay üretmez; `REFRESH` olayının kendisi yeniden bildirim üretmez. Ancak: (1) gece/telafi analizi işlenmemiş bir durum bulursa (ör. yeni fiyat düşüşü, yeniden yayın) olayı (`NEW`/`PRICE_DROP`/`RELIST`) durumdan türetir ve gönderir; (2) bir `REFRESH`/`CHANGE` ilanı daha eşleşebilir yaparsa (güven sırası yükselir: INSUFFICIENT < LOW < MEDIUM < HIGH, ya da güven yeterliyken indirim ≥ 1 puan artar) `NEW` olayı üretilir. Plan 04 bu `NEW`'i "bu profil için ilk eşleşme" saymalı (profil+ilan için zaten eşleşme varsa yinelenmez).

Dayanıklılık:
- İlan başına Redis kilidi (`lock:analyze:<id>`, 60 sn); doluysa iş BullMQ geri çekilmesiyle yeniden denenir.
- Bozuk analiz işi verisi `UnrecoverableError` ile ilk denemede başarısız sayılır (yeniden denenmez).
- Analiz satırı + `latestAnalysisId` tek işlemde yazılır; `match` işi commit sonrası eklenir ve `matchQueuedAt` yazılır. Kuyruğa alınamazsa scheduler 60 sn sonra yeniden gönderir (aynı `jobId` ile tekil). Bu nedenle nadiren yinelenen `match` işi olabilir; tüketici idempotent olmalıdır.
- Gece yenilemesi: İstanbul 03:00'ten sonra günde bir kez (`analysis:nightly:<gün>` Redis `SET NX`). Kuyruğa ekleme başarısız olursa işaret serbest bırakılır ve sonraki tick'te yeniden denenir (iş id'leri güne özgüdür). `SchedulerLoop` her adımı (tarama tick'i, gece yenilemesi, match yeniden gönderimi) ayrı try/catch ile yürütür; biri hata verse diğerleri çalışır.

## 8. Açıklanabilirlik
Her `ListingAnalysis.explanation`: seviye, hedef özeti, emsal başına özet (`id`, fiyat, yıl, km, hasar, düzeltilmiş değer, `clamped`, `outlier`), havuz sayıları (aday, geçersiz fiyat, tekilleştirme sonrası, seviyede, hasarlı çıkarılan, kullanılan, uç değer id'leri), düzeltme yöntemi ve katsayıları, Q1/medyan/Q3/yayılım, güven adımları (`confidenceSteps`), `insufficientReason`, bayraklar ve kullanılan ayarlar. `comparableIds` kullanılan (uç değer olmayan) emsallerdir.

- Tarama sonrası yeniden analiz: başarıyla (`SUCCEEDED`) biten bir taramanın sonunda, o taramada ilk görülen ve son analizi `INSUFFICIENT` olan (ya da hiç analizi olmayan) ilanlar için `REFRESH` analiz işi eklenir (`jobId = analyze-post-<ilanId>-<collectionJobId>`, 500'lük sayfalarla `addBulk`, gerçek zamanlı öncelik). Havuz tarama boyunca dolduğundan ilk analiz zayıf kalan ilanlar böylece güncellenir; hata günlüğe yazılır, tarama işini başarısız yapmaz. Gece yenileme işleri düşük öncelikli (`priority: 100`) eklenir.

## Sertleştirmeler (Plan 07)

- **MANUAL yeniden analiz** (`POST /admin/listings/:id/reanalyze`, `reason: 'MANUAL'`): `REFRESH`in "maddi değişiklik" eşiğini (tahmin > %2, güven/motor sürümü) atlar ve her zaman yeni satır yazar; olay türetmesi aynıdır. Eşik altı değişiklikte (`materiallyChanged` false) "daha eşleşebilir" türevi `NEW` olayı üretilmez, yani bir yönetici tıklaması kullanıcı bildirimi doğurmaz. Gerçek olaylar (`NEW`, `PRICE_DROP`, `RELIST`) her zamanki gibi yayılır. İş `removeOnComplete` ile silindiğinden jobId tamamlandıktan sonra sorgulanamaz.

- Analiz kilidi (`lock:analyze:<id>`) Lua CAS ile bırakılır; kilit TTL'i dolup başka süreç yazdıysa `latestAnalysisId` CAS'ı başarısız olur, satır geri alınır ve `AnalysisLockBusyError` ile iş yeniden denenir (`debug` log).
- `AnalysisSettingsService` Redis `settings:changed` kanalını (mesaj = anahtar) dinler ve `analysis.settings` için önbelleği anında temizler; 60 sn TTL yedek kalır.
- Eşleştirme olayı yeniden gönderimi `matchDispatchAttempts` sayar; 10 denemede takılan satır atlanır ve bir kez `match-dispatch-stuck` alarmı verilir.
- Günlük `SubscriptionSweepService` (Redis `subs:sweep:<istanbulDay>`): süresi dolan ACTIVE abonelikler EXPIRED olur, limiti aşan ACTIVE profiller en yeniden başlayarak PAUSED olur ve kullanıcıya IN_APP `SYSTEM_ALERT` bildirimi gider.
