# Web uygulaması ve kullanıcı paneli (Plan 06)

`apps/web` — Next.js 15 (App Router), React 19, Tailwind 4, TanStack Query, Radix UI. Tüm API sözleşmeleri `@oto/shared` zod şemalarından gelir.

## Çalıştırma
```bash
pnpm db:up && pnpm build:packages && pnpm db:migrate && pnpm db:seed
PUBLIC_BASE_URL=http://localhost:3000 pnpm dev:api   # http://localhost:3001
pnpm dev:web                                          # http://localhost:3000
```
- **Geliştirme notu:** worker ve scheduler `nest start --watch` ile aynı `dist` klasörünü paylaşır; ikisini birden başlatmak derlemeleri çakıştırır. Birini önce başlatın ya da `pnpm --filter @oto/worker build` yapıp her ikisini `node dist/main.js` ile çalıştırın.
- Tarayıcı yalnızca web origin'ine (`:3000`) konuşur. `/api/*` istekleri Next `rewrites` ile `API_ORIGIN` (varsayılan `http://localhost:3001`) adresine yönlenir; çerezler böylece birinci taraf kalır, CORS gerekmez.
- **`API_ORIGIN` build zamanında sabitlenir** (rewrites `next build` sırasında çözülür). Üretim derlemesi doğru `API_ORIGIN` ile yapılmalıdır; `next start` sırasında değiştirmek etkisizdir.
- API ortamında `PUBLIC_BASE_URL=http://localhost:3000` olmalıdır (e-posta bağlantıları ve Telegram "Analizi gör" düğmesi web'e gitsin).
- Üretim derlemesi: `pnpm --filter @oto/web build && pnpm --filter @oto/web start`. Derleme **ağ erişimi gerektirmez**: yazı tipleri kendi barındırılır (`geist`, `@fontsource-variable/inter`, `@fontsource-variable/instrument-sans`); Google Fonts kullanılmaz.

## Rota haritası
| Rota | İçerik |
|---|---|
| `/` | Tanıtım sayfası |
| `/giris`, `/kayit`, `/sifremi-unuttum`, `/reset-password`, `/verify-email` | Kimlik doğrulama |
| `/kvkk` | Aydınlatma metni |
| `/ilan/[id]` | Dış bağlantı (Telegram "Analizi gör"); `/app/ilan/[id]`'ye yönlenir, oturum yoksa middleware girişe alır ve girişten sonra döner |
| `/app` | Pano (özet kartlar, son fırsatlar) |
| `/app/firsatlar` | Fırsat listesi (süzgeçler, keyset sayfalama) |
| `/app/ilan/[id]` | İlan detayı: fiyat bandı, fiyat geçmişi, emsaller, "Bu fiyat nasıl hesaplandı?" paneli |
| `/app/eslesmeler` | Profil eşleşmeleri |
| `/app/profiller`, `/app/profiller/yeni`, `/app/profiller/[id]` | Arama profilleri, 3 adımlı sihirbaz, canlı önizleme |
| `/app/favoriler` | Favoriler (not, geri alma) |
| `/app/bildirimler` | Bildirim listesi, okundu işaretleme |
| `/app/abonelik` | Plan ve limitler (yükseltme ödeme gelene kadar devre dışı) |
| `/app/ayarlar`, `/app/ayarlar/guvenlik`, `/app/ayarlar/kanallar` | Hesap, oturumlar/şifre, Telegram bağlama ve kanallar |
| `/admin`, `/admin/kullanicilar`, `/admin/kullanicilar/[id]` | Yönetim paneli (Plan 07): genel bakış, kullanıcılar, kullanıcı detayı. Diğer bölümler Task 11–12 |

## Yönetim paneli (Plan 07, web)
- **Koruma:** middleware `/admin/*` için de yalnızca `access_token` çerezine bakar. Rol `AdminLayoutClient` (`components/admin/admin-gate.tsx`) içinde `/me`'den okunur; ADMIN/SUPER_ADMIN değilse gerçek 404 ile birebir aynı `NotFoundView` gösterilir (403 değil), kabuk ve akış açılmaz. SUPER_ADMIN'e özel sayfalar gövdelerini `RequireSuperAdmin` ile sarar (ADMIN'e kabuk içinde 404). Asıl yetki API'dedir. `safeNextPath` `/admin` köküne de izin verir.
- **Kabuk:** `AdminShell` Plan 06 `ShellFrame` iskeletini kullanır ("Yönetim" rozetli marka, `Yönetim menüsü`, başlıkta canlı akış göstergesi, kullanıcı paneline dönüş). Menü `ADMIN_NAV` (`superOnly` öğeler: Paketler, Ayarlar, Denetim). Kullanıcı menüsünde adminlere "Yönetim paneli" bağlantısı görünür.
- **Veri:** `lib/admin-api.ts` (`adminGet`/`adminSend`, tipler, `adminErrorMessage` — 409 `INVALID_OPERATION` sunucu mesajı aynen, 5xx gövdesi asla; `adminFieldErrors` — 400 ayrıntılarındaki hem `'a.b'` hem `['a','b']` yollarını normalize eder). `lib/admin-queries.ts`: tüm anahtarlar `['admin', …]` köküyle başlar (`adminKeys`).
- **Canlı akış (`lib/admin-stream.ts`):** `GET /api/v1/admin/stream`; `ready` (tam genel bakış → önbelleğe yazılır, SystemLog alarmları yeniden çekilir), `alert` (`key@at` ile tekil; ERROR `toast.error`, WARN `toast.warning`; "Son alarmlar" listesinin başına eklenir), `job` (`['admin','jobs']`, `['admin','sources']` geçersiz kılınır, `onAdminJob` dinleyicileri), `kpi` (genel bakışa birleştirilir), `ping`. Watchdog ve proaktif yenileme kullanıcı akışıyla aynı; farklar: oturum yenileme yalnızca `ready` görmeden art arda 2+ hatada ve proaktif yenilemede yapılır, kararlı bağlantı olmadan 12 denemeden sonra akış durur. `ready` sonrası kopuş ya da art arda 2 hata `['me']`'yi geçersiz kılar: rol düştüyse kapı 404 verir ve akış kapanır. Kapı kararını önce `me.data`'dan verir; arka plan `/me` hatası çalışma alanını sökmez. Admin kabuğu kullanıcı bildirim akışını açmaz (alarm iki kez toast olmasın).
- **Başlıklar:** `/admin` sunucu metadata'sı nötrdür (`Oto Fırsat`); admin sayfaları `metadata.title` dışa açmaz, başlığı `AdminShell` kapı geçildikten sonra istemcide yazar (`adminPageTitle` + `adminDocumentTitle`).
- **Yardımcılar:** `lib/use-debounced.ts` (`useDebounced(value, ms = 300)`).
- **Redis yokken:** genel bakışta `queues`/`workers` null gelebilir; karolar "—" ve "Redis'e ulaşılamıyor" ipucu gösterir.
- **Yeniden kullanılan bileşenler (`components/admin/`):** `DataTable` (offset `{items,total}`, kontrollü sıralama, çoklu seçim, yükleme/boş/hata, ≤ 768 px kart listesi), `FilterSelect`, `KpiTile`/`KpiGrid`, `StatusBadge` (`STATUS_DEFS` sözlüğü), `ConfirmDialog` (yazarak onay, çift gönderim koruması, hata `role="alert"`).

## Oturum, middleware ve yenileme modeli
- **Middleware (`src/middleware.ts`)** `/app/*` ve `/admin/*` için çalışır ve `access_token` çerezinin varlığına bakar. `refresh_token` çerezi yalnızca `/api/v1/auth` yoluna kısıtlı olduğundan `/app` isteklerinde görünmez. Çerez yoksa `/giris?next=<yol>&try_refresh=1` yönlendirmesi yapılır; giriş sayfası istemcide bir kez oturum yenilemeyi dener, başarılıysa `next`'e `_r=1` ekleyerek **sert gezinme** (`window.location.replace`) ile döner.
- **`_r` döngü koruması:** `_r=1` ile gelen istek hâlâ çerezsizse `/giris?reason=failed` verilir (`try_refresh` eklenmez); yenileme sonsuz döngüye girmez. `next` içinden `_r` temizlenir. **`_r` kalıcı olmaz:** sert gezinme istemci yönlendirme durumunu sıfırlar; ayrıca panel düzenindeki `RetryFlagStripper` adres çubuğundan `_r`yi siler (diğer parametreleri korur) ve `parseOpportunityParams` `_r` dahil bilinmeyen tüm anahtarları atar, böylece süzgeç değişikliklerinde de sızmaz.
- **`safeNextPath`:** `next` parametresi yalnızca `/app` ya da `/admin` ile başlayan, aynı origin'e ait yollara izin verir (`//`, ters eğik çizgi, mutlak URL, kontrol karakterleri/DEL reddedilir); aksi halde `/app`.
- **`apiFetch` (`lib/api.ts`)**: `credentials: 'include'`; mutasyonlarda `X-Requested-With: XMLHttpRequest` (API CSRF guard'ı). 401 (`UNAUTHENTICATED` / `TOKEN_INVALID`) gelirse tek uçuşlu (single-flight) `POST /auth/refresh` yapılıp istek bir kez tekrarlanır; eşzamanlı istekler aynı yenileme promise'ini paylaşır. `/auth/*` yolları ve `noRefresh: true` yenileme denemez.
- **Üç durumlu yenileme sonucu** (`refreshSessionDetailed`): `ok` | `expired` | `transient`. Yalnızca 401 sonuçları (`TOKEN_INVALID`, `REFRESH_REUSED`, ikinci `REFRESH_RACE`) `expired` sayılır ve oturum-bitti işleyicisi çalışır (2 sn'de bir kez; `REFRESH_REUSED` için `/giris?reason=reused`). Ağ hatası, 5xx ve 429 `transient`tir: kullanıcı oturumdan atılmaz, istek özgün hatayla düşer. `REFRESH_RACE` 300 ms sonra bir kez yeniden denenir.
- Çıkış: `purgeUserCache` ile (katalog hariç) önbellek eşzamanlı iptal/silinir, sonra `/giris`e yönlenir ve oturum sonlandırılır; bildirim akışı oturum yayıncısıyla kapatılır. Giriş sayfasının "zaten girişli" denetimi kendi anahtarını (`['session-check']`, `gcTime: 0`) kullanır ve yalnızca bağlandıktan sonraki taze `/me` başarısında yönlendirir; bayat `['me']` önbelleği yönlendirme yapmaz.

## Veri çekme ve önbellek sözleşmesi
- TanStack Query; sorgu anahtarları `lib/*-queries.ts` içinde.
- **FavoriteButton sözleşmesi:** favori değişimi `FAVORITE_CACHE_ROOTS = ['favorites','opportunities','listing','dashboard']` köklerindeki önbellekleri yamalar/geçersiz kılar. İlan/favori/fırsat/pano verisi gösteren her sorgu anahtarı bu dört kökten biriyle BAŞLAMALIDIR; aksi halde kalp durumu bayatlar.
- Keyset sayfalama imleçleri opak tutulur; süzgeç ve URL parametreleri istemcide doğrulanır.

## SSE sözleşmesi ve istemci kuralları (`lib/sse.ts`)
Sunucu tarafı: [notifications.md](notifications.md). Akış `GET /api/v1/me/notifications/stream`, `withCredentials`.
- **`ready` `{ unreadCount, lastId }`**: sayaç `unreadCount`'a sabitlenir; `lastId` yüksek su işareti olarak saklanır ve `id <= lastId` olan `notification` olayları sayaca eklenmez. Her ready/yeniden bağlanmada bildirim listesi yeniden çekilir (Redis kopukluğunda olaylar tekrar oynatılmaz).
- Yalnızca `channel === 'IN_APP'` olaylar işlenir; id ile tekilleştirilir.
- **Watchdog 60 sn:** sunucu 25 sn'de bir `ping` gönderir; 60 sn hiç olay gelmezse bağlantı takılı sayılıp yenilenir.
- **Proaktif yenileme 14 dk 30 sn:** sunucu akışı 15 dk'da kapatır; kopuştan 30 sn önce `refreshSessionDetailed` ile token yenilenip yeniden bağlanılır.
- Hata: üstel geri çekilme (1 sn → 30 sn, ±%20 jitter), her yeniden bağlanma öncesi yenileme. Yenileme `transient` ise (ya da fırlatırsa) yeniden denenir; **`expired` ise akış durur** ve bir daha bağlanmaz. Çıkışta akış `closeNotificationStream` ile kapatılır; tek aktif akış kuralı StrictMode çift bağlantısını engeller.
- **Kısa ömürlü bağlantılar:** `ready`'den sonra 60 sn dolmadan kopan bağlantı art arda 3 kez olursa `ready` geri çekilmeyi sıfırlamaz (sunucu oturum geçersiz/kullanıcı pasif diye akışı bitiriyorsa sıcak döngü olmaz); `ready` sonrası her kopuşta `['me']` geçersiz kılınır.
- **Toast:** MATCH bildirimleri 5 sn'de en fazla 3 toast; fazlası tek "+N yeni eşleşme" toast'unda toplanır. SECURITY/SYSTEM bildirimleri sınırlayıcıya takılmaz.
- Sayaç: `useUnreadCount` sunucu değerini döndürür (akış, istek başladıktan sonra `ready` yazdıysa o daha tazedir); okundu işaretleme iyimser düşürür, sonra sayacı sunucudan yeniden çeker.
- Zil: sayaç `aria-live` bölgesiyle duyurulur; okundu işaretleme hata durumunda geri alınır.

## Tasarım sistemi: "Gece Showroom"
- Tokenlar `src/app/globals.css` (`@theme`). Koyu varsayılan; amber yalnızca fırsat/skor/birincil aksiyon için. Tema `data-theme` ile; `<head>` içindeki satır içi betik (`themeInitScript`) ilk boyamadan önce tercihi uygular. Seçenekler: sistem / açık / koyu.
- **Açık tema AA kuralı:** spec yalnızca koyu amberi sabitler; açık temada metin ve kontrol renkleri WCAG AA sağlar: accent `#8A4A0C` (bg/surface/surface-2 üzerinde 5.9–6.9:1), `danger-text #A81D22`, `positive-text #176843`, `warning-text #6F4E08`, kontrol sınırları için `border-strong #7A8088` (>=3:1). Koyu tarafta `border-strong #6A7079`.
- Yazı tipleri: Instrument Sans (başlık), Inter (gövde), Geist Mono (sayılar, `.num`). Hepsi self-hosted.
- Geist Mono: sayılar ve makine tanımlayıcıları/kod (URL, alan adı, JSON); düz metinde kullanılmaz.
- Bileşenler: `components/ui/*` (badge, button, card, dialog, dropdown-menu, input, label, select, separator, sheet, skeleton, switch, tabs, tooltip), imza bileşenler: `ScoreRing`, `ConfidenceMeter`, `PriceBand`, `PriceHistoryChart`, `ListingCard`/`ListingTable`, `ExplanationPanel`, `FavoriteButton`, `NotificationBell`, `ProfileWizard`/`ProfilePreview`, `AppShell`.
- İndirim rengi işarete göre seçilir; INSUFFICIENT tahminler "zayıf tahmin" etiketiyle gösterilir. Açıklama paneli motorun gerçek davranışını yansıtır (hasarlı ilan dışlama sayıları ham açıklamadan).

## Güvenlik başlıkları
`next.config.mjs` her yola ekler: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`; `X-Powered-By` kapalı. CSP henüz YOK (satır içi tema betiği nedeniyle nonce/hash gerekir; Plan 08'e taşındı).

## Erişilebilirlik kuralları
- "İçeriğe geç" bağlantısı; tüm etkileşimli öğelerde görünür `:focus-visible` (amber, 2px); menülerde görünür odak çubuğu.
- Durum değişiklikleri `aria-live` bölgeleriyle duyurulur (form hataları, zil, sihirbaz adımları); adım değişiminde odak taşınır.
- Her sayfada tek `<h1>` (kabuk başlığı `<p>`; h1 sayfa içeriğinde, bazı sayfalarda `sr-only`); sayfa başlıkları rota `metadata`sından (`Fırsatlar · Oto Fırsat`).
- Renk tek başına anlam taşımaz; `prefers-reduced-motion` animasyonları keser.
- Mobil (390 px): çekmece menü yeniden boyutlanınca kapanır; tablolar kart satırlarına dönüşür.

## Testler
```bash
pnpm --filter @oto/web test        # vitest + jsdom + msw (api, sse, middleware, sayfa ve bileşen testleri)
pnpm --filter @oto/web typecheck   # next typegen && tsc --noEmit
pnpm lint && pnpm test && pnpm test:e2e && pnpm build
```
API tarafı `apps/api/test/panel.e2e.spec.ts` (Testcontainers) ile test edilir.

## Görsel smoke
`apps/web/scripts/screenshots.mjs` (Playwright) çalışan yığına karşı kullanıcı kaydeder, e-postayı DB'den doğrular, profil oluşturur ve ana sayfaların 1440x900 koyu/açık ile 390x844 koyu ekran görüntülerini `apps/web/.screenshots/` altına alır (gitignore); konsol hataları ve 4xx/5xx yanıtları `report.json`'a yazılır.
```bash
pnpm --filter @oto/web exec playwright install chromium
# yığın: migrate+seed, dev:demo (DEMO_SIZE=2000 DEMO_TICK_MS=0), api, worker, scheduler, web
node apps/web/scripts/screenshots.mjs
```

## Bilinen sınırlar / sonraya bırakılanlar
Bkz. [yol haritası](superpowers/plans/2026-10-10-00-roadmap.md), "Plan 06 sonrası taşınan maddeler".
