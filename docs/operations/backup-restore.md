# Yedekleme ve geri yükleme

`backup` servisi (`docker/backup.Dockerfile`, taban `postgres:16-alpine`) her gece `pg_dump` yedeği alır, rotasyon uygular ve isteğe bağlı olarak S3'e yükler. Geri yükleme testi (`restore-test.sh`) **aylık ve elle** çalıştırılır. Komutlarda kullanılan `dc` takma adı [deploy.md](deploy.md#kabuk-hijyeni-ve-sır-ifşası) dokümanında tanımlıdır:

```bash
dc() { env -i HOME="$HOME" PATH="$PATH" docker compose --env-file .env.prod "$@"; }
```

> **Her zaman `exec -u postgres` kullanın:** `dc exec -u postgres backup <komut>`. Scriptler root ile çağrılırsa kendilerini zaten `postgres` kullanıcısına düşürür. Yine de alışkanlık olarak `-u postgres` yazın: dump'lar ve yedek dizini `postgres:postgres` sahipliğinde, `0700`/`0600` izinlidir. Konteynerin root'u bu izinleri aşamaz (`DAC_OVERRIDE` yetkisi verilmez).

## Zamanlama

| Değişken | Varsayılan | Not |
|---|---|---|
| `BACKUP_CRON` | `0 3 * * *` | 5 alanlı cron ifadesidir ve **yalnız sayı ve `* / , -`** içerebilir. `@daily` ya da `MON` gibi adlar reddedilir, konteyner açılmaz. Cron enjeksiyonu da bu kuralla engellenir |
| `BACKUP_TZ` | `Europe/Istanbul` | Konteynerin `TZ`'si olur, cron saati ve dump adları bu saate göre üretilir. İstanbul'da yaz saati uygulaması yoktur (sürekli UTC+3), bu yüzden adlar her zaman artar |
| `BACKUP_KEEP_DAILY` / `BACKUP_KEEP_WEEKLY` | `7` / `4` | En yeni N günlük ve M haftalık dump saklanır |
| `BACKUP_WEEKLY_DAY` | `7` | Haftalık kopyanın alındığı gün (1 = Pazartesi … 7 = Pazar) |
| `BACKUP_MAX_AGE_MIN` | `1560` (26 sa) | Healthcheck sınırı (en az 60) |

> **`BACKUP_TZ`'yi kurulumdan sonra değiştirmeyin.** Rotasyon dosyaları **ada göre** sıralar (`oto-YYYYmmdd-HHMMSS.dump`, en yeni N tanesi kalır). Saat dilimi geriye kaydırılırsa (ör. İstanbul → UTC) yeni dump'ların adları eski dump'lardan "küçük" görünebilir ve rotasyon önce yenileri silebilir. Değiştirmek zorundaysanız eski dump'ları önce sunucu dışına kopyalayın, sonra `daily/` ve `weekly/` dizinlerinden kaldırın.

### Bir gecelik çalıştırmanın akışı (`backup.sh`)

1. `/backups/.lock` üzerinde dışlayıcı bir `flock` alınır. Başka bir yedek ya da geri yükleme testi sürüyorsa çalıştırma **atlanır**: script çıkış 1 verir ve logda "bu çalıştırma atlandı" yazar. Bu durumda `.last-status` değişmez.
2. Tek bir `psql` oturumu `REPEATABLE READ` salt-okunur bir transaction açar, `pg_export_snapshot()` çağırır ve **aynı anlık görüntüde** sayımları okur. Okunan sayımlar `_prisma_migrations` (toplam ve bitmemiş), `User`, `Listing` ve `ListingAnalysis` tablolarınındır. `pg_dump --snapshot` tam olarak bu anlık görüntüden döker. Sonuçta `oto-<ts>.counts` manifesti dump ile birebir tutarlıdır.
3. Dump `pg_dump -Fc` ile önce `.partial` dosyasına yazılır. Dosyanın boş olmadığı ve `pg_restore --list` ile okunabildiği doğrulanır. Ardından manifest ve dump atomik `mv` ile `daily/` altına taşınır.
4. Haftalık gün ise dosyalar `weekly/` altına hardlink'lenir (hardlink olmazsa kopyalanır).
5. Rotasyon **yalnızca** doğrulanmış yeni dump'tan sonra yapılır. `.counts` dosyası dump'ıyla birlikte silinir.
6. `BACKUP_S3_URI` ayarlıysa `aws s3 cp` çalışır (bkz. aşağıda).

**Yük:** dump sürerken pg_dump bağlantısına ek olarak bir `psql` oturumu ve açık bir transaction tutulur, yani toplam 2 bağlantı kullanılır. Bunu bağlantı bütçesine katın ([deploy.md](deploy.md#connection_limit-hesabı)). Açık transaction süresince `VACUUM` ölü satırları temizleyemez. Dump tablolarda `ACCESS SHARE` kilidi tuttuğu için `ALTER TABLE` yapan bir migration dump bitene kadar bekler. Bu yüzden yedek penceresinde (03:00) dağıtım yapmayın.

Elle yedek:

```bash
dc exec -u postgres backup backup.sh
dc exec -u postgres backup ls -l /backups/daily /backups/weekly
```

## Healthcheck

`backup` konteyneri 5 dakikada bir denetlenir ve şu koşulların hepsi sağlanırsa sağlıklıdır:

- `crond` çalışıyor.
- `/backups/.last-status` `fail` değil ve son başarılı çalıştırma `BACKUP_MAX_AGE_MIN` dakikadan yeni.
- En yeni günlük dump `BACKUP_MAX_AGE_MIN` dakikadan yeni. Hiç dump yoksa (ilk kurulum) açılıştan sonraki `BACKUP_MAX_AGE_MIN` dakika boyunca sağlıklı sayılır.

```bash
docker inspect --format '{{json .State.Health}}' "$(dc ps -q backup)"   # yalnız sağlık alanı (env yazdırmaz)
dc logs --tail 100 backup
```

**`fail` durumunu temizlemek:** önce nedeni loglardan bulup düzeltin (disk dolu, parola, postgres erişimi). Ardından elle bir yedek alın (`dc exec -u postgres backup backup.sh`). Başarılı çalıştırma `.last-status`'u `ok` yapar ve bir sonraki healthcheck'te konteyner sağlıklı olur.

**Notlar:**
- `start_interval` (açılışta 2 sn'de bir denetim) Docker Engine 25+ ve Compose 2.20+ gerektirir.
- Taban imaj `postgres:16-alpine` `/var/lib/postgresql/data` için `VOLUME` tanımlar. Bu yüzden `backup` konteyneri her oluşturulduğunda kullanılmayan bir **anonim volume** oluşur. Bu volume zararsızdır ama birikir. Zaman zaman `docker volume ls -f dangling=true` ile kontrol edin ve `docker volume prune` ile temizleyin. `prune` yalnız hiçbir konteynere bağlı olmayan volume'leri siler, ama komutu çalıştırmadan önce yığının ayakta olduğundan emin olun.

## Sunucu dışı kopya (zorunlu)

`backups` volume'ü **aynı diskte** durur. Disk ya da sunucu kaybında yedekler de kaybolur. Bu yüzden yedekler mutlaka sunucu dışına kopyalanmalıdır. Kopyaya `.counts` manifestleri de **dahil edilmelidir**, çünkü restore testi bunlarla karşılaştırır.

`backup` servisi yalnız iç `backend` ağındadır ve dışa çıkamaz. İki seçenek vardır.

### A) rclone yan konteyneri (önerilen)

`backups` volume'ünü **salt-okunur** bağlayan ayrı bir servis kurun. `backup` konteynerine dış ağ ya da bulut kimlik bilgisi verilmez. Örnek `docker-compose.override.yml` (sunucuda, repoya girmez):

```yaml
services:
  offsite:
    image: rclone/rclone:<sabit-sürüm>
    restart: unless-stopped
    entrypoint: ["sh", "-c"]
    # Saatte bir kopyalar; nokta ile başlayanlar (.lock, .last-status, .partial) hariç
    command: ["while true; do rclone copy /backups uzak:oto-yedek --exclude '.*' --log-level INFO; sleep 3600; done"]
    volumes:
      - backups:/backups:ro
      - ./rclone.conf:/config/rclone/rclone.conf:ro   # chmod 600; uzak hedef kimlik bilgileri
    networks: [egress]
```

`rclone copy` uzakta dosya silmez. Uzak taraftaki saklama süresini kova yaşam döngüsü kuralıyla belirleyin (ör. 90 gün). Kopyanın gerçekten oluştuğunu düzenli kontrol edin: `rclone ls uzak:oto-yedek/daily | tail`.

### B) Yerleşik S3 yüklemesi

1. İmajı aws CLI ile derleyin: `dc build --build-arg WITH_AWS_CLI=true backup`. Bu imajı yaklaşık 100 MB büyütür.
2. `backup` servisine override ile `networks: [backend, egress]` ekleyin.
3. `.env.prod` içinde `BACKUP_S3_URI=s3://<kova>/oto`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ve `AWS_DEFAULT_REGION` değişkenlerini ayarlayın. S3 uyumlu bir servis kullanıyorsanız `AWS_ENDPOINT_URL` de verin.

Bu durumda her gece dump ve `.counts` dosyası `daily/` altına yüklenir; haftalık gün ise `weekly/` altına da yüklenir. Yükleme başarısız olursa çalıştırma `fail` sayılır ve healthcheck bozulur. Yerel dump yine de yerinde kalır.

> `DATA_ENCRYPTION_KEY`'i de **ayrı ve güvenli** bir yerde saklayın (parola kasası). Dump bu anahtar olmadan geri yüklenebilir, ama Telegram kanalları ve proxy URL'leri okunamaz.

## Geri yükleme testi (aylık, elle)

`restore-test.sh` bir dump'ı geçici `oto_restore_<ts>` veritabanına tek transaction'da geri yükler. Ardından iki şeyi doğrular: bitmemiş migration olmamalı ve sayılar manifestle birebir aynı olmalı. Geçici veritabanı her durumda silinir.

**Önerilen yol:** testi ayrı ve atılabilir bir Postgres 16 sunucusuna karşı çalıştırın. Böylece üretim veritabanı CPU ve disk yükü almaz:

```bash
read -rs RESTORE_PGPASSWORD                                # parola komut satırına/geçmişe girmez
env -i HOME="$HOME" PATH="$PATH" RESTORE_PGPASSWORD="$RESTORE_PGPASSWORD" \
  docker compose --env-file .env.prod exec -u postgres \
  -e RESTORE_PGHOST=<test-sunucusu> -e RESTORE_PGUSER=<kullanıcı> -e RESTORE_PGPASSWORD \
  backup restore-test.sh                                   # varsayılan: en yeni günlük dump; ya da sona dump yolu:
                                                           # ... backup restore-test.sh /backups/weekly/oto-<ts>.dump
unset RESTORE_PGPASSWORD
```

- Değersiz `-e RESTORE_PGPASSWORD` değeri compose'u çalıştıran süreçten alır. `dc` takma adı `env -i` ile ortamı temizlediği için parolayı yukarıdaki gibi açıkça aktarın. `RESTORE_PGHOST` verildiğinde kaynak sunucunun parolası test sunucusuna **gönderilmez**.
- Test sunucusu `backup` konteynerinden erişilebilir olmalıdır. Konteyner yalnızca `backend` ağındadır, bu yüzden test sunucusunu da aynı ağda çalışan geçici bir konteyner olarak kurmak en kolay yoldur. Örnek: `docker run -d --rm --name restoredb --network <proje>_backend -e POSTGRES_PASSWORD=... postgres:16-alpine`, ardından `RESTORE_PGHOST=restoredb` kullanın. Bu yöntem `scripts/backup-restore-check.sh` ile aynıdır.
- Hedef kaynakla aynı sunucuysa (bu `system_identifier` ile tespit edilir) script `RESTORE_TEST_ON_PROD=1` olmadan **çıkış 2** verir. Üretim sunucusunda test yalnızca yoğun olmayan saatte ve açık onayla yapılır: `dc exec -u postgres -e RESTORE_TEST_ON_PROD=1 backup restore-test.sh`.
- **03:00 yedeğiyle çakıştırmayın.** Test sırasında yedek kilidi paylaşımlı tutulur. O sırada başlayan gece yedeği **atlanır**: çıkış 1 olur ve logda "atlandı" görünür. Test bittikten sonra `dc exec -u postgres backup backup.sh` ile eksik yedeği alın. Yedek sürerken başlatılan test ise kilidi en fazla `RESTORE_TEST_LOCK_WAIT` (600) sn bekler.
- Çıkış kodları: `0` doğrulandı, `1` başarısız (boş, bozuk ya da kesik dump, geri yükleme hatası, manifest yok ya da sayılar uyuşmuyor), `2` hedef üretim sunucusu ve onay yok.
- Manifesti olmayan eski dump'lar yalnızca `RESTORE_TEST_LIVE_COMPARE=1` ile canlı veritabanının o anki sayılarıyla karşılaştırılır. Bu karşılaştırma canlı yazmalar yüzünden yanlış alarm verebilir.

Sonucu ve süreyi aylık operasyon kaydına yazın.

## Geri yükleme prosedürü

Gerçek bir veri kaybında ya da sunucu taşımada izlenecek adımlar:

1. **Dump'ı seçin.** Günlük dump'lar son 7 günü, haftalık dump'lar (`weekly/`, Pazar) son 4 haftayı kapsar. Daha eskisi yalnızca sunucu dışı kopyada bulunur. Dump'ı ve `.counts` dosyasını not edin.
2. **Uygulamayı durdurun.** Yazma olmasın ve veritabanına bağlantı kalmasın:
   ```bash
   dc stop caddy web api worker scheduler
   ```
3. **Dump'ı `backup` konteynerine getirin** (sunucu dışından geliyorsa). Dosya `postgres` kullanıcısına ait olacak biçimde stdin üzerinden yazılır:
   ```bash
   dc exec -T -u postgres backup sh -c 'cat > /backups/restore.dump' < oto-<ts>.dump
   ```
   Tersi, yani dump'ı sunucudan dışarı almak için:
   ```bash
   dc exec -T -u postgres backup cat /backups/daily/oto-<ts>.dump > oto-<ts>.dump
   ```
   Alternatif olarak `docker compose cp backup:/backups/daily/oto-<ts>.dump .` de kullanılabilir.
4. **Geri yükleyin.** İki yol vardır. `backup` konteynerinde `PG*` env'i hazırdır, parola komut satırına girmez.
   - **(Önerilen) Yeni veritabanı + yeniden adlandırma:** eski veritabanı geri dönüş için korunur.
     ```bash
     dc exec -u postgres backup sh -c 'createdb --no-password -T template0 oto_new \
       && pg_restore --no-owner --exit-on-error --single-transaction -d oto_new /backups/daily/oto-<ts>.dump'
     dc exec -u postgres backup psql -X -d postgres -c 'ALTER DATABASE oto RENAME TO oto_old' \
       -c 'ALTER DATABASE oto_new RENAME TO oto'
     ```
     Yeniden adlandırma, hedef veritabanlarına bağlantı varken başarısız olur. 2. adımda servislerin durdurulduğundan emin olun. `oto_old`'u birkaç gün sonra `dropdb oto_old` ile silin.
   - **Yerinde (`--clean`):**
     ```bash
     dc exec -u postgres backup pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction \
       -d oto /backups/daily/oto-<ts>.dump
     ```
     `--clean` yalnızca dump'taki nesneleri düşürür. Dump'tan sonra eklenmiş tablolar (daha yeni migration'lar) kalır ve sonraki `migrate deploy` adımında çakışabilir. Bu nedenle ilk yol tercih edilir.
   - Veritabanı adı `POSTGRES_DB` değilse komutlardaki `oto` adını değiştirin.
5. **Roller dump'ta yoktur.** `pg_dump` rolleri ve parolaları içermez. Yeni bir sunucuda uygulama rolü (`POSTGRES_USER`) postgres imajının ilk açılışında `.env.prod`'daki değerlerle oluşur. `--no-owner` ile tüm nesneler bağlanan kullanıcıya ait olur.
6. **Migration'ları uygulayın.** Dump eski bir sürümdense şemayı güncel koda getirin. Bu adımda `SEED_ON_MIGRATE` false olmalıdır.
   ```bash
   dc run --rm migrate
   ```
7. **Doğrulayın ve başlatın:**
   ```bash
   dc exec -u postgres backup psql -X -At -d oto -c 'select count(*) from "User"'   # .counts ile karşılaştırın
   dc up -d --wait
   ```
   Redis yedeklenmez. Kuyruklar boş başlar. Kaybolan bildirim ve eşleştirme işlerini scheduler süpürmeleri veritabanından yeniden kuyruğa alır (`PENDING` bildirimler, gönderilmemiş eşleştirmeler). Yarım kalan tarama işleri 30 dk sonra `FAILED` olarak kapatılır.
8. Yeni sunucuda **aynı `DATA_ENCRYPTION_KEY`** kullanılmalıdır. Aksi halde Telegram kanalları ve proxy'ler okunamaz.
