# Alarmlar ve müdahale

Alarm üretimi ve teslimi [docs/admin.md](../admin.md#alarmlar-ve-eşikler) dokümanında tanımlıdır. Bu doküman nöbetçi için yazılmıştır: hangi alarmın ne anlama geldiğini ve ne yapılacağını anlatır.

## Teslim ve susturma

- Her alarm `SystemLog` satırına (WARN/ERROR) yazılır ve tüm ACTIVE adminlere IN_APP `SYSTEM_ALERT` bildirimi olarak gider. Bildirim `admin:events` üzerinden panelin canlı akışına da düşer.
- Doğrulanmış ve etkin Telegram kanalı olan adminler alarmı ayrıca Telegram'dan alır.
- **Susturma:** aynı anahtar 30 dk içinde bir kez teslim edilir (`alert:<key>`, Redis `SET NX`). Monitörün her adımda yeniden değerlendirdiği koşullarda SystemLog satırı da çoğalmaz.
- **Kalıcı durumlar** (`source:<id>:down`, `source:<id>:blocked`) **6 saatte bir** hatırlatılır. Tarama yolu (`SourceHealthService`) ve monitör aynı anahtarı ve aynı 6 saatlik susturmayı kullanır. Sonuç olarak **tek engel ya da tek DOWN, 6 saat boyunca tek alarmdır**.
- **Worker kaybı** tek seferlik bir alarmdır. Aynı kayıp (aynı son nabız) için alarm yinelenmez.
- Monitör yalnız lider scheduler'da çalışır. Çalışma aralığı en fazla `MONITOR_INTERVAL_MS` (varsayılan 60 sn) olur. Eşikler her adımda `alerts.thresholds` ayarından okunur, bu yüzden ayar değişikliği yeniden başlatmadan etkili olur.
- Hiç aktif admin yoksa susturma anahtarı bırakılır ve sonradan eklenen admin alarmı yine alır.

## Alarm anahtarları ve eşikler

Varsayılan eşikler: `{ notifyQueueDepth: 500, notifyFailureRate: 0.10, parserErrorRate: 0.2, heartbeatMissSec: 60 }`. Bu değerler Admin → Ayarlar → `alerts.thresholds` üzerinden değiştirilir.

| Anahtar | Kaynak | Koşul | Seviye / yineleme |
|---|---|---|---|
| `source:<id>:down` | tarama + monitör | Etkin kaynak 6 ardışık hatayla DOWN | ERROR, 6 saatte bir |
| `source:<id>:blocked` | tarama + monitör | Etkin kaynak engel sinyaliyle (403/captcha) PAUSED. Yönetici duraklatması (`isActive=false`) alarm üretmez | ERROR, 6 saatte bir |
| `source:<id>:degraded` | tarama | 3 ardışık hata | WARN, 30 dk |
| `source:<id>:parse` | tarama + monitör | Monitör: son 1 saatte PARSE hatası / sayfa oranı `parserErrorRate` değerini aşar (en az 20 sayfa). Tarama: tek işte ilanların %20'sinden fazlası ayrıştırılamaz ya da sayfa yapısı tanınmaz | WARN, 30 dk |
| `source:<id>:mass-removal` | tarama | Tam bir taramada kaldırma adayı sayısı güvenlik sınırını aşar. Toplu kaldırma **atlanır**, ilanlar ACTIVE kalır | WARN, 30 dk |
| `queue:notify:depth` | monitör | `notify` + `notify-telegram` kuyruklarında bekleyen + gecikmiş iş sayısı `notifyQueueDepth` değerini aşar | WARN, 30 dk |
| `notify:failure-rate` | monitör | Son 1 saatte MATCH ve dış kanal alarm teslimleri için FAILED / (SENT+FAILED) oranı `notifyFailureRate` değerini aşar. `USER_INACTIVE` ve `NOT_ADMIN` sayılmaz | ERROR, 30 dk |
| `worker:<host>:<pid>:lost` | monitör | Görülmüş bir worker ya da scheduler `heartbeatMissSec` süresinden uzun nabız göndermiyor | ERROR, tek sefer |
| `telegram:unauthorized` | monitör | Worker, Telegram Bot API'den 401 aldı (token geçersiz ya da iptal). Bayrak son 401'den sonra 1 saat durur | ERROR, bayrak durdukça 30 dk'da bir |
| `match-dispatch-stuck:<id>` | scheduler süpürmesi | Analiz 10 denemede eşleştirme kuyruğuna alınamadı | ERROR, bir kez |

Alarm olmayan ama `SystemLog`'a düşen önemli satırlar:

- `telegram` WARN: production worker'ında `TELEGRAM_BOT_TOKEN` yok. Satır her açılışta bir kez yazılır ve Telegram bildirimleri gönderilmez.
- `telegram` ERROR: bir Telegram güncellemesi 5 denemede işlenemedi ve atlandı ([telegram-bot.md](telegram-bot.md#hata-davranışı)).

## Müdahale runbook'u

Komutlardaki `dc` takma adı için bkz. [deploy.md](deploy.md#kabuk-hijyeni-ve-sır-ifşası).

### `source:<id>:blocked`
1. Admin → Kaynaklar → kaynak → istatistikler ve son hatalar. Engel sinyalinin türüne bakın (403, captcha).
2. **Engeli aşmaya çalışmayın.** Stealth, captcha çözme, UA sahteciliği ya da proxy rotasyonu kullanılmaz (kaynak etiği). Kaynak sahibiyle iletişime geçin. Bot sayfası `BOT_CONTACT_URL` adresindedir. Gerekirse hız ve aralık ayarlarını düşürün.
3. Sorun çözüldükten sonra `activate` ile engeli sıfırlayın. Engel ancak bu şekilde kalkar; kaynağı duraklatmak engeli silmez. Önce dry-run ile deneyin.

### `source:<id>:down` / `degraded`
1. Kaynak işlerinin hata özetlerine bakın (Admin → İşler).
2. Ağ ve DNS sorunu için worker loglarına bakın: `dc logs --tail 200 worker`. Sorun kaynak tarafındaysa (5xx) bekleyin; başarılı bir tarama sayacı sıfırlar.
3. Uzun sürecekse kaynağı yönetici olarak duraklatın (`pause`). Bu `isActive=false` yapar ve alarm durur.

### `source:<id>:parse`
Kaynağın HTML yapısı değişmiş olabilir. Admin → ilan sorunları ve `ScrapeError` (PARSE) örneklerine bakın. Adapter düzeltmesi bir kod değişikliğidir, bkz. [adding-a-source.md](../adding-a-source.md). O zamana kadar kaynağı duraklatın.

### `source:<id>:mass-removal`
Tek taramada çok sayıda ilan kayboldu. Bu genellikle bir listeleme sayfası değişikliği ya da kısmi bir yanıttır. Sistem kaldırmayı zaten atladı. Kaynağın sitesini kontrol edin. Durum gerçekse (kaynak ilanlarını gerçekten kaldırdıysa) sonraki taramalar aynı alarmı vermeye devam eder. Bu durumda kaynak yapılandırmasını inceleyin.

### `queue:notify:depth`
1. Admin → Kuyruklar: `notify` ve `notify-telegram` için bekleyen, gecikmiş ve aktif iş sayılarına bakın.
2. Worker'lar canlı mı? Admin → Worker'lar ve `dc ps worker`.
3. `notify-telegram` gecikmişleri çoksa Telegram 429 (hız sınırı) ya da sohbet başına 1 msj/sn kapısı nedeniyledir ve kendiliğinden erir. Uzun süre erimiyorsa worker sayısını artırın (`WORKER_REPLICAS`, [deploy.md](deploy.md#ölçekleme-ve-bağlantı-bütçesi)).

### `notify:failure-rate`
1. Admin → Bildirimler: `FAILED` satırlarındaki `lastError` dağılımına bakın.
2. `TELEGRAM_DISABLED` görüyorsanız worker'da token yoktur. Aynı anda `telegram:unauthorized` varsa token geçersizdir ([telegram-bot.md](telegram-bot.md)).
3. Ağ hatalarında worker'ın `egress` ağına ve DNS'e bakın. Sorun düzeldikten sonra yeniden deneme yapın: `POST /admin/notifications/retry` (Admin → Bildirimler, ≤ 100 kayıt, son 7 gün).

### `worker:<host>:<pid>:lost`
1. `dc ps` ile konteynerlerin durumuna bakın. `restart: unless-stopped` çöken süreci yeniden başlatır. Yeni süreç farklı bir `<pid>` (ve konteyner yeniden oluşturulduysa farklı bir `<host>`) ile görünür.
2. `dc logs --tail 200 worker` ile çökme nedenine bakın (OOM, env hatası).
3. Dağıtım sırasında SIGKILL ile kapanan bir worker da bu alarmı **bir kez** üretir. Yeni worker'lar sağlıklıysa ek işlem gerekmez. Ölü kayıt 24 saat sonra listeden düşer.
4. Kayıp worker'ın yarım bıraktığı işler BullMQ'da stalled olarak yeniden işlenir. Tarama satırları 30 dk sonra `FAILED` kapanır. Scheduler, BullMQ'da karşılığı olmayan ve 2 dk'dan eski **yetim QUEUED** tarama işlerini aynı `jobId` ile yeniden kuyruğa ekler; ekleyemezse `FAILED` yapar. Böylece kaynak 30 dk boyunca "meşgul" kalmaz.

### `telegram:unauthorized`
Token iptal edilmiş ya da yanlıştır. BotFather'dan token'ı kontrol edin, `.env.prod` dosyasını güncelleyin, api ve worker'ı yeniden başlatın ve webhook'u yeniden kurun ([telegram-bot.md](telegram-bot.md#token-değişimi)).

### `match-dispatch-stuck:<id>`
Admin → İlanlar/analizler → "Takılı eşleştirme gönderimleri" (`GET /admin/match-dispatches/stuck`). Önce nedeni bulun; çoğunlukla Redis erişimidir. Ardından `reset` ile sayacı sıfırlayıp yeniden gönderin. Bu işlem denetim kaydına yazılır.

### Scheduler hiç tick yapmıyor
- Lider kilidini başka bir örnek tutuyor olabilir. Scheduler logunda `scheduler standby: leader lock held by another instance` (`info`, bekleme durumuna her girişte bir kez) satırı görünür. Lider kilidi kaybedilirse `scheduler leader lock lost; ticking stopped, retrying as standby` (`warn`) yazılır. Tek scheduler çalıştığını doğrulayın (`dc ps scheduler`).
- Kilit 30 sn TTL'lidir. Çöken bir liderin kilidi en geç 30 sn içinde düşer.

### Yedek alarmı (healthcheck unhealthy)
Bkz. [backup-restore.md](backup-restore.md#healthcheck). Yedek sağlığı panel alarmı üretmez. `backup` konteynerinin `unhealthy` durumunu sunucu izlemenizle takip edin (ör. `docker ps --filter health=unhealthy`).
