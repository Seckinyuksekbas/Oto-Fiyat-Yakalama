# Telegram botu (operasyon)

Bildirim akışı, mesaj şablonu ve bağlama akışı [docs/notifications.md](../notifications.md) dokümanındadır. Bu doküman kurulumu, webhook yönetimini ve sır rotasyonunu anlatır. Telegram isteğe bağlıdır. Token yoksa uygulama içi bildirimler yine çalışır.

## Hangi süreç neye ihtiyaç duyar

| Değişken | api | worker | scheduler |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | evet (bağlama, webhook) | **evet** (gönderim) | hayır (Telegram'a hiç bağlanmaz) |
| `TELEGRAM_BOT_USERNAME` | token varken zorunlu (deep link) | — | — |
| `TELEGRAM_MODE` | production'da `webhook` zorunlu | — | — |
| `TELEGRAM_WEBHOOK_SECRET` | webhook modunda zorunlu | — | — |
| `TELEGRAM_API_BASE` | isteğe bağlı, production'da https | isteğe bağlı, production'da https | hayır (compose aktarmaz; varsayılanı vardır, kullanılmaz) |

**Token hem api'de hem worker'da olmalıdır.** Compose ikisine de aynı `.env.prod` değerini (ve varsa `TELEGRAM_API_BASE`'i) aktarır; scheduler'a ikisini de aktarmaz. Biri eksikse sorun sessizce ortaya çıkar:

- **api'de yoksa:** bağlama 503 `FEATURE_DISABLED` döner. Panelde `telegramAvailable=false` görünür.
- **worker'da yoksa:** kullanıcılar bağlanabilir ama planlayıcı TELEGRAM satırı üretmez, yani yalnızca IN_APP bildirim gider. Gönderim anında token yoksa sonuç `FAILED (TELEGRAM_DISABLED)` olur. Production worker'ı bu durumda açılışta bir `warn` logu ve bir `SystemLog` WARN satırı (bileşen `telegram`) yazar. Bu satırı Admin → Sistem logları ekranında görebilirsiniz.

## Kurulum

1. Telegram'da **@BotFather** ile konuşun ve `/newbot` komutunu verin. Bot adını ve kullanıcı adını (`..._bot`) seçin, token'ı alın.
   - İsteğe bağlı: `/setdescription`, `/setuserpic`. `/setjoingroups` ile grup eklemeyi kapatın; bot yalnızca özel sohbet içindir.
2. `.env.prod` dosyasına şunları yazın:
   ```
   TELEGRAM_BOT_TOKEN=<BotFather token'ı>
   TELEGRAM_BOT_USERNAME=<bot kullanıcı adı, @ olmadan>
   TELEGRAM_MODE=webhook
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32 çıktısı>
   ```
   Secret 32–256 karakter `[A-Za-z0-9_-]` olmalıdır. api ve script aynı kuralı uygular.
3. api ve worker'ı yeniden oluşturun: `dc up -d --wait api worker`. `dc` takma adı için bkz. [deploy.md](deploy.md#kabuk-hijyeni-ve-sır-ifşası).
4. Webhook'u kurun (aşağıya bakın).
5. Doğrulama: panelde Ayarlar → "Telegram'ı bağla" adımını izleyin ve deep link ile `/start` gönderin. Bot `✅ <maskelenmiş e-posta> hesabı bağlandı. Eşleşen fırsatlar artık buraya gelecek.` yanıtını vermelidir.

## Webhook yönetimi: `pnpm telegram:webhook set|info|delete`

`scripts/telegram-webhook.mjs` Bot API'yi doğrudan çağırır ve **yalnızca süreç ortamını** okur. `.env` ya da `.env.prod` dosyalarını kendisi yüklemez. Token ve secret hiçbir çıktıda görünmez, çıktılarda token biçimli her değer maskelenir. Bir hatada script çıkış 1 verir.

| Komut | Gerekli env | Ne yapar |
|---|---|---|
| `set` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_BASE_URL` (https) | `setWebhook` çağırır: `url=<PUBLIC_BASE_URL>/api/v1/telegram/webhook`, `secret_token`, `allowed_updates=["message","callback_query","my_chat_member"]`, `drop_pending_updates=false` |
| `info` | `TELEGRAM_BOT_TOKEN` | `getWebhookInfo`: URL, bekleyen güncelleme sayısı, `last_error_message` |
| `delete` | `TELEGRAM_BOT_TOKEN` | `deleteWebhook` (bekleyen güncellemeler korunur) |

`allowed_updates` içinde **`my_chat_member` bulunmalıdır.** Kullanıcı botu engellediğinde kanalı devre dışı bırakan güncelleme budur. Elle `curl setWebhook` çağrısı yapacaksanız bu listeyi unutmayın. Script ile kurmak en güvenli yoldur.

Script sunucuda Node 22 ile repo kökünden çalıştırılır. Değerler yalnız alt kabuğa aktarılır; bu sayede kabuk geçmişine ve compose ortamına sızmazlar:

```bash
( set -a; eval "$(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|PUBLIC_BASE_URL)=' .env.prod)"; set +a
  node scripts/telegram-webhook.mjs set )
( set -a; eval "$(grep -E '^TELEGRAM_BOT_TOKEN=' .env.prod)"; set +a; node scripts/telegram-webhook.mjs info )
```

Geliştirme makinesinde `pnpm telegram:webhook <komut>` aynı scripti çalıştırır; scriptin npm bağımlılığı yoktur.

## Webhook güvenliği

- Uç nokta: `POST /api/v1/telegram/webhook`. Bu uç nokta CSRF ve throttle dışındadır ve kimlik doğrulaması `X-Telegram-Bot-Api-Secret-Token` başlığıyla yapılır. Başlık, SHA-256 özetleri üzerinden sabit zamanlı karşılaştırılır.
- Mod `webhook` değilse, token ya da secret yoksa veya başlık uyuşmuyorsa yanıt **401** olur.
- Uç nokta Caddy üzerinden yayınlanır; Telegram yalnızca https adresine gönderir.

## Hata davranışı

- **Webhook:** işleyici hatası verirse yanıt **500** olur ve Telegram aynı güncellemeyi yeniden dener. Her başarısızlık Redis'te `tg:update:fail:<update_id>` sayacını artırır (24 sa TTL). **5. başarısızlıkta** güncelleme "zehirli" sayılır. Yanıt **200** olur, böylece Telegram yeniden denemeyi bırakır ve kuyruk kilitlenmez. Ayrıca `SystemLog` ERROR satırı yazılır (bileşen `telegram`; içerikte yalnızca `updateId`, deneme sayısı, kaynak ve hata türü bulunur, gizli bilgi yoktur). Redis de çalışmıyorsa sayaç tutulamaz ve yanıt 500 kalır.
- **Polling (yalnız geliştirme):** hata durumunda offset ilerlemez. Aynı güncelleme üstel beklemeyle (1 sn → en fazla 30 sn) yeniden denenir. **5 denemeden sonra** atlanır ve aynı `SystemLog` ERROR satırı yazılır. `getUpdates` hataları için bekleme süreleri: 409 (webhook tanımlı ya da başka bir yoklayıcı var) 30 sn, 401 60 sn, 429 için `retry_after`, diğer hatalar 5 sn.
- **Bağlama (`/start <kod>`) hataları:**
  - **Geçici** DB hataları (bağlantı, zaman aşımı, kilit; Prisma `P1001`, `P1002`, `P1008`, `P1017`, `P2024`, `P2028`, `P2034`, başlatma hataları ve ağ kodları) yeniden fırlatılır. Webhook 500 döner, Telegram yeniden dener ve kullanıcıya "kod geçersiz" **denmez**.
  - **Kalıcı** hatalar (doğrulama hatası, diğer kodlar) bir kez loglanır. Kullanıcıya genel bir hata yanıtı verilir ve yeniden deneme zorlanmaz.
  - Kod yok, kullanılmış ya da süresi dolmuşsa, ya da hesap aktif veya doğrulanmış değilse bot `Bağlantı kodu geçersiz veya süresi dolmuş. Panelden yeni bir kod oluşturun.` yanıtını verir.
- **Gönderim (worker):** 401 olursa `telegram:unauthorized` alarmı üretilir ([alarms.md](alarms.md)). 403 ya da "chat not found" durumunda kanal kapatılır ve kullanıcıya `TELEGRAM_DISABLED` güvenlik bildirimi gider. Ayrıntılar: [notifications.md](../notifications.md#kalıcı-hatalar-ve-kanal-kapatma).

## Webhook secret rotasyonu

Yeni secret'ı api'den **önce** Telegram'a vermeyin. Önce api yeni secret'ı beklemeli, sonra Telegram ona geçirilmelidir:

1. Yeni secret üretin: `openssl rand -hex 32`.
2. `.env.prod` içinde `TELEGRAM_WEBHOOK_SECRET` değerini değiştirin.
3. api'yi yeniden oluşturun: `dc up -d --wait api`. Bu andan itibaren eski secret'la gelen güncellemeler 401 alır. Telegram bunları **yeniden dener**, yani kaybolmazlar.
4. Hemen `set` çalıştırın (yukarıdaki alt kabuk komutu). Telegram yeni secret'a geçer ve bekleyen güncellemeleri teslim eder.
5. `info` ile `pending_update_count` değerinin düştüğünü ve `last_error_message` alanının boş ya da eski olduğunu kontrol edin.

3. ve 4. adımlar arasındaki birkaç saniyede güncellemeler gecikir ama kaybolmaz. Secret sızdığından şüpheleniyorsanız rotasyonu hemen yapın.

## Token değişimi

Token'ı BotFather'da `/revoke` ile yenileyebilirsiniz; eski token anında geçersiz olur.

1. Yeni token'ı `.env.prod` içinde `TELEGRAM_BOT_TOKEN` olarak yazın.
2. `dc up -d --wait api worker`. İkisi de yeni token'ı almalıdır.
3. `set` komutunu yeni token'la yeniden çalıştırın. Webhook kaydı bot düzeyindedir, yine de bunu yapın ki URL ve `allowed_updates` güncel olsun.
4. `telegram:unauthorized` alarmı, son 401'den sonra 1 saat boyunca Redis bayrağı (`telegram:unauthorized:at`) durdukça 30 dk'da bir yinelenebilir. Yeni token ile başarılı gönderimler başladıktan sonra Admin → Bildirimler ekranında `FAILED` satırlarını yeniden deneyin.

Kullanıcıların bağlantıları korunur. Sohbet kimlikleri bota değil kullanıcıya aittir ve aynı bot kullanıcı adıyla devam eder.

## Polling ↔ webhook geçişi

- Production'da yalnızca `webhook` kabul edilir. Token varken `TELEGRAM_MODE=polling` api açılışında reddedilir.
- **Geliştirmede polling'e geçiş:** önce `delete` çalıştırın. Webhook tanımlıyken `getUpdates` 409 döner ve polling döngüsü 30 sn'de bir uyararak bekler. Ardından `TELEGRAM_MODE=polling` yapıp api'yi yeniden başlatın.
- **Webhook'a geçiş:** `TELEGRAM_MODE=webhook` ile secret'ı ayarlayın, api'yi yeniden başlatın, sonra `set` çalıştırın. Webhook kurulunca bekleyen güncellemeler webhook'a akar.
- Aynı bot token'ını iki ortamda (ör. staging ve production) **kullanmayın.** Webhook bot başına tektir ve son `set` komutu kazanır. Her ortama ayrı bir bot açın.
