# Bildirimler (Plan 05)

Her yeni `ListingMatch` için kaybolmayan, günlük limitli ve yeniden denenen bildirimler üretilir; uygulama içi (kayıt + canlı SSE) ve Telegram kanallarında teslim edilir. Eşleştirme: [matching.md](matching.md). Tasarım: spec §5.4–5.7.

## Akış

```
match kuyruğu → MatchService (tx: ListingMatch + Notification PENDING, NotificationPlanner)
              → commit → NotificationDispatcher → notify (IN_APP) | notify-telegram (TELEGRAM)
              → NotifyWorkerHost → NotifyService → InAppAdapter | TelegramAdapter → SENT | FAILED
scheduler süpürmesi: queuedAt IS NULL ve 60 sn'den eski PENDING satırlar yeniden kuyruğa alınır
```

1. `MatchService` eşleşmeyi yazarken **aynı transaction'da** `NotificationPlanner` her kanal için `Notification(PENDING)` satırı ekler (`INSERT … ON CONFLICT ("matchId","channel") DO NOTHING`). Worker commit sonrası çökse bile bildirim kaybolmaz.
2. Commit **sonrası** `NotificationDispatcher` her satırı `jobId = notify-<id>` ile kanalına göre `notify` (IN_APP) veya `notify-telegram` (TELEGRAM, limiter 25 iş/sn) kuyruğuna ekler ve `queuedAt` yazar.
3. `NotifyWorkerHost` işi `NotifyService.process`'e verir; adapter sonucu `SENT`, `RETRYABLE` veya `PERMANENT` olarak sınıflanır. Bildirim `SENT` (`sentAt`, `latencyMs`) veya `FAILED` (`lastError`) olur.
4. Kuyruğa girememiş satırları scheduler (`NotificationSweepService`) 60 sn sonra, en eskiden başlayarak 500'lük sayfalarla yeniden ekler.

## Kanal seçimi

```
kanallar = ({IN_APP} ∪ profil.channels) ∩ ({IN_APP} ∪ geçerli plan.channels) ∩ ({IN_APP} ∪ doğrulanmış + etkin kanallar)
```

`EMAIL` hiçbir zaman teslim edilmez (bu planın kapsamı dışında). Plan düşürülürse kayıtlı TELEGRAM kanalı artık kullanılmaz; gönderim anında da plan yeniden kontrol edilir.

## Günlük limit ve kilitler

- Sayılan: bugün (Europe/Istanbul) oluşturulmuş, `SKIPPED_LIMIT` olmayan, IN_APP dışı `MATCH` bildirimleri (`/me` kullanım sayacıyla aynı tanım). Sınır: planın `maxNotificationsPerDay` değeri.
- Karar, eşleşme transaction'ı içinde kullanıcı başına `pg_advisory_xact_lock(4243, hashtext(userId))` altında DB sayımıyla verilir; tüm kullanıcı kilitleri tek ifadede hashtext anahtar sırasıyla alınır (deadlock yok). Redis sayacı kullanılmaz.
- Limit aşılırsa harici kanal satırı `SKIPPED_LIMIT` olur; IN_APP satırı yine `PENDING` oluşur ve `payload.limitExceeded = true` taşır (kullanıcı fırsatı panelde görür).

## Yeniden deneme

- Her iş 5 deneme hakkıyla eklenir (`attempts: 5`). Beklemeler özel backoff stratejisiyle: 10 sn, 30 sn, 2 dk, 10 dk. 5. denemeden sonra bildirim `FAILED` olur.
- Telegram 429'da bekleme = `max(retry_after, takvim)` (`retry_after` yoksa 5 sn varsayılır). 5xx, ağ hatası ve zaman aşımı geçici sayılır.
- **Sohbet başına 1 msj/sn:** Redis kapısı `SET tg:chat:<hash> 1 PX 1100 NX`. Kapı alınamazsa iş, kapının kalan süresine (gate `PTTL` + küçük rastgele sapma) ertelenir (`moveToDelayed` + `DelayedError`); bu **deneme hakkı yemez**.
- **Beklenmeyen hata güvenlik ağı:** adapter'ın sınıflayamadığı (örn. DB/Redis) bir hata fırlarsa `NotifyWorkerHost` bunu `recordUnexpectedFailure` ile kaydeder: deneme sayılır, `lastError` yazılır (bot token'ı maskelenir), son denemede satır `FAILED` olur; satır sonsuza dek `PENDING` kalmaz.

## Kalıcı hatalar ve kanal kapatma

- 403 (bot engellendi / kullanıcı devre dışı) ve 400 "chat not found" → bildirim `FAILED` + Telegram kanalı `isEnabled=false` + kullanıcıya IN_APP `SECURITY` bildirimi (`type: TELEGRAM_DISABLED`). Aynı kullanıcının bekleyen diğer Telegram bildirimleri gönderim anında `FAILED (CHANNEL_UNAVAILABLE)` olur, yeniden denenmez.
- Diğer 400 → `FAILED`. 401 (geçersiz token) → `FAILED` + error log.
- Gönderim anında yeniden kontrol (bilinçli): kullanıcı ACTIVE değilse `USER_INACTIVE`; TELEGRAM için kanal doğrulanmış + etkin değilse veya plan TELEGRAM içermiyorsa `CHANNEL_UNAVAILABLE`. Yani `notify` işi kuyrukta beklerken plan/kanal değişirse gönderim anındaki durum geçerlidir.
- Fotoğraf: `imageUrl` varsa `sendPhoto` (caption); "wrong file identifier", "failed to get HTTP URL content" vb. 400 hatalarında bir kez `sendMessage`'a düşülür.

## Süpürme

`NotificationSweepService.requeuePending` scheduler döngüsünde çalışır: `status = PENDING AND queuedAt IS NULL AND createdAt < now − 60 sn` satırları (IN_APP/TELEGRAM) yeniden kuyruğa ekler. `jobId` sabit olduğundan aynı bildirim iki kez kuyrukta beklemez.

## SSE olay sözleşmesi

`GET /api/v1/me/notifications/stream` (oturum çerezi gerekir):

| Olay | Veri | Not |
|---|---|---|
| `ready` | `{ unreadCount, lastId }` | İlk olay; okunmamış IN_APP sayısı ve o anki en büyük IN_APP bildirim id'si (yoksa `null`) |
| `notification` | bildirim özeti (`id, kind, channel, status, payload, createdAt`) | Redis `user:<id>` kanalından; yalnızca kendi kullanıcınızın olayları |
| `ping` | `{}` | 25 sn'de bir |

İstemci kuralları: `id <= lastId` olan `notification` olayları sayaca eklenmez (zaten `unreadCount` içindedir); olaylar id ile tekilleştirilir; her `ready` ve yeniden bağlanmada liste yeniden çekilir (Redis bağlantısı koptuğu sürede yayımlanan olaylar tekrar oynatılmaz).

Akış **15 dk sonra sunucu tarafından kapatılır**; istemci yeniden bağlanır. Kimlik doğrulama yalnızca bağlantı kurulurken yapılır: akış açıkken kullanıcı çıkış yapsa (logout) bile açık akış kapanmaz ve 15 dk'lık ömür dolana kadar o bağlantıya olay gelmeye devam eder. İstemci çıkışta akışı kendisi kapatmalıdır. Yeni bağlantı için geçerli oturum gerekir.

## API

- `GET /me/notifications` — cursor sayfalama (`cursor`, `limit`); yanıt `{ items, nextCursor, unreadCount }`. `unreadCount` = IN_APP ve `readAt IS NULL`.
- `POST /me/notifications/read` — yalnızca kullanıcının IN_APP bildirimlerini okundu işaretler; yanıt `{ updated }`.
- `GET /me/channels` — `{ items: [IN_APP, TELEGRAM], telegramAvailable }`. `config`/chatId asla dönmez.
- `POST /me/channels/telegram/link` (201, dakikada 5) — `{ deepLink, expiresAt }`. Önkoşullar: Telegram yapılandırılmış (yoksa 503 `FEATURE_DISABLED`), e-posta doğrulanmış (403 `EMAIL_NOT_VERIFIED`), plan TELEGRAM içeriyor (403 `LIMIT_REACHED`).
- `PATCH /me/channels/:type` — Telegram kanalını aç/kapat (`isEnabled`); IN_APP kapatılamaz.
- `DELETE /me/channels/telegram` — bağlantıyı kaldırır (204).

## Telegram kurulumu

1. Telegram'da **@BotFather** ile `/newbot`; bot token'ını ve kullanıcı adını alın.
2. Ortam değişkenleri: `TELEGRAM_BOT_TOKEN` (API ve worker); API'de ayrıca `TELEGRAM_BOT_USERNAME` (token varken zorunlu), `TELEGRAM_MODE` (`polling` | `webhook`), `TELEGRAM_WEBHOOK_SECRET` (webhook modunda zorunlu, 32-256 karakter `[A-Za-z0-9_-]`), isteğe bağlı `TELEGRAM_API_BASE`. Token yoksa bağlama 503 döner ve TELEGRAM bildirimi planlanmaz. **Token hem API'de hem worker'da ayarlı olmalıdır:** worker'da yoksa planlayıcı TELEGRAM satırı üretmez (yalnızca IN_APP), API'de yoksa bağlama yapılamaz. Üretimde `TELEGRAM_API_BASE` (worker dahil) https olmalıdır.
3. **Geliştirme:** `TELEGRAM_MODE=polling` — API içinde `getUpdates` döngüsü çalışır (409 çakışmasında 30 sn bekler).
4. **Üretim:** `TELEGRAM_MODE=webhook` kullanın (production'da zorunludur) ve webhook'u `pnpm telegram:webhook set` (`scripts/telegram-webhook.mjs`) ile kurun. Script `allowed_updates` listesine `my_chat_member`'ı da ekler; bu güncelleme bot engellendiğinde kanalı kapatmak için gereklidir. Elle `curl setWebhook` çağrısı bu listeyi atlarsa engelleme algılanmaz. Kurulum, secret ve token rotasyonu ile hata davranışı: [operations/telegram-bot.md](operations/telegram-bot.md).

Uç nokta `X-Telegram-Bot-Api-Secret-Token` başlığını sabit-zamanlı karşılaştırır; uyuşmazsa 401.

5. **Üretimde worker `PUBLIC_BASE_URL` zorunludur** ve `localhost` olamaz (`BOT_CONTACT_URL` ile birlikte açıkça ayarlanmazsa worker açılışta env doğrulamasında düşer). "Analizi gör" bağlantısı bu adresten üretilir; localhost/özel adresli URL'ler Telegram tarafından reddedileceği için o düğme eklenmez.

## Bağlama akışı

1. Panelde `POST /me/channels/telegram/link` → `deepLink` (`https://t.me/<bot>?start=<kod>`). Kod 16 baytlık base64url'dür, yalnızca hash'i saklanır, **10 dk** geçerli ve tek kullanımlıktır; yeni kod eskileri geçersiz kılar.
2. Kullanıcı bağlantıyı açar, bot `/start <kod>` alır. Kod geçersiz/kullanılmış/süresi dolmuşsa veya hesap doğrulanmamış/aktif değilse bot açıklayıcı yanıt verir ve bağlanmaz.
3. Başarıda kanal (`config` AES-256-GCM şifreli `{ chatId }`, `externalIdHash = sha256(chatId)`) doğrulanmış ve etkin olarak yazılır; bot "✅ Hesabınız bağlandı" yanıtını verir, panelde IN_APP `SECURITY` bildirimi (`TELEGRAM_LINKED`) SSE ile yayınlanır.
4. "Favorile" butonu `callback_data = fav:<listingId>` ile sohbetin bağlı olduğu kullanıcının favorilerine ekler. Kullanıcı botu engellerse (`my_chat_member` kicked/left) kanal kapatılır.

## Teslim garantisi

**En az bir kez (at-least-once).** Gönderim başarılı olup ardından DB güncellemesi (`SENT` yazımı) başarısız olursa ya da işin kilidi gönderim sırasında kaybolup iş yeniden işlenirse (stalled) aynı bildirim ikinci kez gönderilebilir. Kayıp yoktur, nadiren yineleme olabilir.

## `latencyMs`

`latencyMs = sentAt − listing.firstSeenAt` (payload'daki ISO tarih), tüm kanallarda. `NEW` için bu "ilan görüldükten bildirim ulaşana kadar" gecikmesidir. **`PRICE_DROP` ve `RELIST` için de ölçüm başlangıcı ilanın ilk görülme zamanıdır**, olayın kendisi değil; bu türlerde değer ilanın yaşı kadar büyük olabilir. Gecikme metriği (p50/p95) yorumlanırken türe göre ayrılmalıdır (olay zamanından ölçüm Plan 07'de değerlendirilecek).

## Mesaj şablonu

```
🔥 Fırsat · Skor 82 · Güven: Yüksek
BMW 3 Serisi 320i · 2022
💰 960.000 TL   (Piyasa ≈ 1.280.000 TL)
📉 320.000 TL altında · %25
🛣 40.000 km · Benzin · Otomatik · İstanbul
📊 14 benzer ilan ile karşılaştırıldı
🕒 İlk görülme: 11.10.2026 03:10

Fiyat analizi tahminidir; aracın durumunu garanti etmez.
[İlana git] [Favorile] [Analizi gör]
```

Başlık: `NEW` için indirim > 0 ve güven ≠ INSUFFICIENT ise "🔥 Fırsat", değilse "🆕 Yeni ilan"; `PRICE_DROP` için "📉 Fiyat düştü: <önceki> → <yeni> TL"; `RELIST` için "🔁 Yeniden yayında". Tarihler Europe/Istanbul, sayılar `tr-TR` biçimindedir. Metin HTML kaçışlıdır; fotoğraflı mesajda caption 1024, düz mesajda 4096 karakterle sınırlıdır.

## Gecikme ve saklama (Plan 07)

`MatchNotificationPayload.eventAt` (NEW: ilanın `firstSeenAt`'i; PRICE_DROP/RELIST: analizin `createdAt`'i) payload'a yazılır; `latencyMs = sentAt - eventAt` (eski satırlarda `eventAt` yoksa `listing.firstSeenAt`). Başarısız bildirim işleri 7 gün saklanır (`NOTIFY_JOB_OPTS.removeOnFail`).
