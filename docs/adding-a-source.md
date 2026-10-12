# Yeni veri kaynağı ekleme

## 1. Önce izin (zorunlu)
Kod yazmadan önce aşağıdakilerin **hepsi** yazılı olarak doğrulanmalıdır:

- [ ] Kaynağın kullanım koşulları otomatik erişime izin veriyor **veya** yazılı lisans/partner anlaşması var.
- [ ] İzin verilen istek sıklığı ve erişim yöntemi (API, feed, HTML) belli.
- [ ] Verinin platformda gösterilmesine/ticari kullanımına izin var.
- [ ] Kaynağın engelleme veya bot doğrulaması (captcha) kullanıp kullanmadığı biliniyor. Kullanıyorsa ve izin yoksa **kaynak eklenmez**.

İzin belgesinin özeti `DataSource.permissionNote`'a, doğrulama tarihi `permissionVerifiedAt`'a yazılır. Bu alan boşken kaynak aktif edilemez (DB kısıtı).

**Yasak olanlar:** stealth eklentileri, tarayıcı parmak izi gizleme, captcha çözme servisleri, sahte User-Agent, engellendikçe IP/proxy değiştirme. Sistem 403/captcha/robots engelinde kaynağı otomatik **PAUSED** yapar ve yeniden denemez.

## 2. Adapter
1. `packages/collection/src/adapters/<kaynak>.adapter.ts` oluştur ve `SourceAdapter`'ı uygula:
   - `listPages(ctx)`: sayfaları sırayla `ctx.http.getText(url)` ile çek; her sayfa için `{ url, pageNo, html, isLast }` üret. Ağ erişimi **yalnızca** `ctx.http` üzerinden (robots, hız limiti, yeniden deneme orada).
   - `parseList(page)`: her ilanı `RawListing`'e çevir; zorunlu alanı eksik kartı `problems`'a ekle (atla, uydurma).
   - `isBlockedPage(html)` (opsiyonel): kaynağa özgü engel sayfası işareti.
   - Config'i kendi zod şemanla doğrula (`baseUrl`, `maxPages` vb.).
2. `packages/collection/src/registry.ts`'deki `FACTORIES`'e bir satır ekle.
3. Kaynağın HTML örneklerinden fixture'lı test yaz (`demo-site.adapter.spec.ts` örneği).
4. Yeni marka/model yazımları için `MakeModelAlias` kayıtları ekle.

## 3. Kayıt
`DataSource` satırı: `adapterKey`, `kind`, `permissionType`, `permissionNote`, `permissionVerifiedAt`, `intervalSec`, `minRequestGapMs` (kaynağın izin verdiği sıklığa göre), `config`. Admin API'si (`/admin/sources`) ile oluşturulur (`isActive=false` başlar; `config.baseUrl` production'da iç ağ adreslerini gösteremez). Etkinleştirme için `permissionVerifiedAt` dolu olmalıdır (aksi halde 409). `POST /admin/sources/:id/test-scrape {dryRun:true}` en fazla 2 liste sayfasını çekip ilk 20 normalize ilanı `CollectionJob.dryRunResult` içine yazar; ilan/sağlık/analiz değişmez (kaynak başına dakikada 1).

## 4. İzleme
- `CollectionJob`: her taramanın sayaçları ve durumu.
- `ScrapeError`: ağ/engel hataları. `ListingIssue`: ayrıştırılamayan/doğrulanamayan ilanlar.
- `SystemLog` + admin panel bildirimi: engellenme, ardışık hata, %20 üzeri ayrıştırma hatası.
- Kaynaktan kaynaklanmayan worker hataları (DB/Redis erişimi, kurulum) işi `Altyapı hatası` / `Kurulum hatası` mesajıyla FAILED yapar ve kaynağın sağlık durumunu etkilemez.
- Duraklatılmış kaynağı yeniden açmak: `POST /admin/sources/:id/activate` (engel kaynaklı PAUSED ise health `HEALTHY`, `consecutiveFailures=0`) — önce engelin nedenini ve izni kontrol edin. Yönetici duraklatması (`POST /admin/sources/:id/pause`) yalnız `isActive=false` yazar; sağlık değişmez ve dry-run yapılabilir.

## İlk gerçek kaynaktan önce (zorunlu)
Demo kaynağı bu maddeleri gerektirmez; ilk gerçek kaynak canlıya alınmadan **hepsi** kapatılmalıdır:

- [ ] **İlerleme tabanlı stale tespiti:** Şu an RUNNING iş yalnızca süreye göre `stale` sayılıyor; uzun taramalar yanlışlıkla kapatılabilir. Lease/heartbeat (ör. her sayfada `updatedAt` yenileme) ile ilerlemeye bakılmalı.
- [ ] **Çapraz-origin yönlendirme:** `maxRedirections` başka bir origin'e gidebilir. Yönlendirilen origin için robots + hız limiti uygulanmalı ya da çapraz-origin yönlendirme reddedilmeli.
- [ ] **Crawl-delay:** robots.txt `Crawl-delay` değerine uyulmalı (`minRequestGapMs` ile maksimumu alınarak).
- [ ] **Yanıt gövdesi boyut sınırı:** `res.body.text()` öncesinde bayt üst sınırı uygulanmalı.
- [ ] **Toplu kaldırma eşikleri:** `MASS_REMOVAL_MIN` / `MASS_REMOVAL_RATIO` (scrape-runner) kaynak başına gözden geçirilmeli.
- [ ] **Adapter'a özgü `LayoutError` kontrolleri:** Sayfa yapısı beklenen işaretçileri taşımıyorsa (sayfalama, toplam sayı, ilan kapsayıcısı) adapter `LayoutError` fırlatmalı; sessizce boş sayfa dönmemeli.

## Admin SSRF ve test taraması notları

- Admin API'de URL doğrulaması (`config.baseUrl`, proxy URL'si) `NODE_ENV !== 'production'` iken iç ağ adreslerine izin verir (worker ile tutarlı; demo-site için); production'da DNS çözümü sonrası özel adresler reddedilir, proxy kontrolü ayrıca bağlantı anında `guardedLookup` ile korunur (DNS rebinding).
- `PAUSED` (engel sinyali) kaynakta dry-run dahil test taraması yapılmaz (409); dry-run sırasında engel (403/captcha/robots) alınırsa kaynak normal tarama gibi duraklatılır ve uyarı üretilir.
- Zamanlayıcı aralığı yalnızca dry-run olmayan işlerden hesaplanır; uçuştaki herhangi bir iş yeni zamanlanmış işi engeller.
