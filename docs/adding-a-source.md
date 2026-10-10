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
`DataSource` satırı: `adapterKey`, `kind`, `permissionType`, `permissionNote`, `permissionVerifiedAt`, `intervalSec`, `minRequestGapMs` (kaynağın izin verdiği sıklığa göre), `config`. Admin paneli Plan 07'de gelir; o zamana kadar seed veya SQL ile.

## 4. İzleme
- `CollectionJob`: her taramanın sayaçları ve durumu.
- `ScrapeError`: ağ/engel hataları. `ListingIssue`: ayrıştırılamayan/doğrulanamayan ilanlar.
- `SystemLog` + admin panel bildirimi: engellenme, ardışık hata, %20 üzeri ayrıştırma hatası.
- Kaynaktan kaynaklanmayan worker hataları (DB/Redis erişimi, kurulum) işi `Altyapı hatası` / `Kurulum hatası` mesajıyla FAILED yapar ve kaynağın sağlık durumunu etkilemez.
- Duraklatılmış kaynağı yeniden açmak (Plan 07'ye kadar): `UPDATE "DataSource" SET health='HEALTHY', "consecutiveFailures"=0 WHERE code='<kod>';` — önce engelin nedenini ve izni kontrol edin.
