#!/usr/bin/env sh
# Yedekleme + geri yükleme testinin uçtan uca doğrulaması (Plan 08 Task 10).
#
#   sh scripts/backup-restore-check.sh
#
# docker-compose.yml'den yalnız postgres + migrate (seed'li) + backup servisleri, ayrı bir compose projesi
# (oto-backup-check) olarak ayağa kalkar. Uygulama imajları (oto/migrate) DERLENMEZ, mevcut olan kullanılır;
# yalnız oto/backup derlenir. Kontroller:
#   1. backup servisi healthy (crond + healthcheck), TZ ve BACKUP_CRON crontab'a işlenmiş
#   2. backup.sh elle tetiklenir → geçerli günlük dump
#   3. restore-test.sh → 0 (geçici DB'ye geri yükleme; migration + User/Listing/ListingAnalysis sayıları)
#   4. 0 baytlık ve bozuk dump → restore-test.sh ≠ 0; geçici DB kalmaz
#   5. kaynakla uyuşmazlık (fazladan migration satırı) → restore-test.sh ≠ 0
#   6. rotasyon: 10 sahte günlük + 6 sahte haftalık → backup.sh sonrası 7 günlük + 4 haftalık
#   7. başarısız pg_dump → backup.sh ≠ 0, yarım dosya kalmaz
#   8. Postgres parolası loglarda / çıktılarda görünmez
#
# Gizli değerler (.env.prod.backupcheck) çalışma anında üretilir ve çıkışta silinir; yığın `down -v` ile kaldırılır.
set -eu

# Git Bash (MSYS) "/backups/..." gibi argümanları Windows yoluna çevirmesin.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

PROJECT=${BACKUP_CHECK_PROJECT:-oto-backup-check}
ENVF=.env.prod.backupcheck
FAILS=0
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t oto-backup-check)
command -v cygpath >/dev/null 2>&1 && TMP=$(cygpath -m "$TMP")
OUT="$TMP/out" # tüm komut çıktıları buraya da yazılır (parola sızıntısı taraması için)
: >"$OUT"

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
dc() { docker compose -p "$PROJECT" -f docker-compose.yml --env-file "$ENVF" "$@"; }
# backup konteynerinde postgres kullanıcısı olarak (cron işinin kullanıcısı) komut çalıştırır
bk() { dc exec -T -u postgres backup "$@"; }
# komutu çalıştırır, çıktısını $TMP/last'a ve $OUT'a yazar, çıkış kodunu $RC'ye koyar
run() {
  set +e
  "$@" >"$TMP/last" 2>&1
  RC=$?
  set -e
  cat "$TMP/last" >>"$OUT"
}
show() { sed 's/^/      | /' "$TMP/last" | tail -n "${1:-8}"; }
count() { bk sh -c "ls -1 /backups/$1 2>/dev/null | grep -cE '^oto-[0-9]{8}-[0-9]{6}\\.dump\$' || true" | tr -d '\r '; }

cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ -f "$ENVF" ]; then
    if [ "$code" -ne 0 ] || [ "$FAILS" -gt 0 ]; then
      echo "==> Hata ayıklama: servis durumu ve son loglar"
      dc ps -a 2>/dev/null || true
      dc logs --no-color --tail 30 backup 2>/dev/null || true
    fi
    echo "==> Kapanış: docker compose down -v"
    dc down -v --remove-orphans --timeout 30 >/dev/null 2>&1 || true
  fi
  rm -f "$ENVF"
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for f in docker-compose.yml docker/backup.Dockerfile docker/backup/backup.sh docker/backup/crontab scripts/restore-test.sh; do
  if [ ! -f "$f" ]; then
    echo "FAIL $f yok"
    exit 1
  fi
done
if ! docker image inspect oto/migrate:latest >/dev/null 2>&1; then
  echo "FAIL oto/migrate:latest imajı yok (önce: docker compose build migrate)"
  exit 1
fi

# --- 1. Geçici env (compose interpolasyonu için tüm zorunlular; yalnız postgres/migrate/backup çalışır) ------
echo "==> $ENVF üretiliyor"
PGPW=$(rand_hex 16)
umask 077
{
  echo "# backup-restore-check.sh tarafından üretildi; çıkışta silinir"
  echo "POSTGRES_USER=oto"
  echo "POSTGRES_DB=oto"
  echo "POSTGRES_PASSWORD=$PGPW"
  echo "REDIS_PASSWORD=$(rand_hex 16)"
  # Aşağıdakiler yalnız compose'un zorunlu interpolasyonu için: api/worker/caddy bu testte başlatılmaz.
  echo "JWT_PRIVATE_KEY=unused-$(rand_hex 8)"
  echo "JWT_PUBLIC_KEY=unused-$(rand_hex 8)"
  echo "DATA_ENCRYPTION_KEY=unused-$(rand_hex 8)"
  echo "SITE_ADDRESS=oto.localtest.me:8443"
  echo "ACME_EMAIL=ops@example.com"
  echo "PUBLIC_BASE_URL=https://oto.localtest.me:8443"
  echo "BOT_CONTACT_URL=https://oto.localtest.me:8443/bot"
  echo "SMTP_HOST=mailpit"
  echo "SMTP_PORT=2525"
  echo "SMTP_FROM=no-reply@example.com"
  echo "SEED_ON_MIGRATE=true"
  echo "SEED_ADMIN_EMAIL=backup-check@example.com"
  echo "SEED_ADMIN_PASSWORD=Bk-$(rand_hex 12)"
} >"$ENVF"
umask 022

# --- 2. Ayağa kaldırma: postgres → migrate (+seed) → backup ----------------------------------------------
echo "==> backup imajı derleniyor (yalnız oto/backup)"
run dc build backup
if [ "$RC" -eq 0 ]; then pass "oto/backup derlendi"; else fail "backup derlemesi (kod $RC)"; show 20; exit 1; fi

echo "==> postgres + migrate (seed) + backup (proje: $PROJECT)"
run dc up -d --no-build --wait --wait-timeout 120 postgres
if [ "$RC" -eq 0 ]; then pass "postgres healthy"; else fail "postgres up (kod $RC)"; show 20; exit 1; fi
run dc run --rm --no-deps -T migrate
if [ "$RC" -eq 0 ]; then pass "migrate + seed tamamlandı"; else fail "migrate (kod $RC)"; show 20; exit 1; fi
run dc up -d --no-build --no-deps --wait --wait-timeout 120 backup
if [ "$RC" -eq 0 ]; then pass "backup servisi healthy"; else fail "backup up --wait (kod $RC)"; show 20; exit 1; fi

echo "==> Konfigürasyon"
user=$(dc exec -T backup sh -c 'ps -o user,comm | awk "\$2==\"crond\"{print \$1}"' | tr -d '\r')
[ -n "$user" ] && pass "crond çalışıyor (kullanıcı: $user)" || fail "crond çalışmıyor"
tz=$(bk date +%z | tr -d '\r')
if [ "$tz" = "+0300" ]; then pass "TZ Europe/Istanbul (+0300)"; else fail "saat dilimi ofseti '$tz'"; fi
cron=$(dc exec -T backup cat /etc/crontabs/root | grep -v '^#' | tr -d '\r')
case "$cron" in
  "0 3 * * * "*backup.sh*) pass "crontab: varsayılan BACKUP_CRON '0 3 * * *'" ;;
  *) fail "crontab beklenmiyor: '$cron'" ;;
esac
run bk /usr/local/bin/healthcheck.sh
if [ "$RC" -eq 0 ]; then pass "healthcheck.sh 0 (henüz yedek yok, açılış payı)"; else fail "healthcheck.sh $RC"; show; fi

# --- 3. Elle yedek -------------------------------------------------------------------------------------
echo "==> backup.sh (elle tetikleme)"
run bk backup.sh
if [ "$RC" -eq 0 ]; then pass "backup.sh 0"; else fail "backup.sh kod $RC"; fi
show 4
n=$(count daily)
if [ "$n" = "1" ]; then pass "daily/ altında 1 dump"; else fail "daily dump sayısı '$n' (1 bekleniyor)"; fi
run bk sh -c 'ls -A /backups/daily | grep -c partial || true'
if [ "$(tr -d '\r ' <"$TMP/last")" = "0" ]; then pass "geçici (.partial) dosya kalmadı"; else fail "geçici dosya kaldı"; fi
run bk sh -c 'f=$(ls -1 /backups/daily/oto-*.dump | tail -n 1); pg_restore --list "$f" | grep -c "TABLE DATA"'
if [ "$RC" -eq 0 ] && [ "$(tr -d '\r ' <"$TMP/last")" -gt 0 ]; then pass "dump pg_restore --list ile okunuyor ($(tr -d '\r ' <"$TMP/last") TABLE DATA)"; else fail "dump okunamadı"; show; fi

# --- 4. Geri yükleme testi -------------------------------------------------------------------------------
echo "==> restore-test.sh (son dump)"
run bk restore-test.sh
if [ "$RC" -eq 0 ]; then pass "restore-test.sh 0"; else fail "restore-test.sh kod $RC"; fi
show 10
grep -q '_prisma_migrations' "$TMP/last" && pass "migration karşılaştırması raporlandı" || fail "migration satırı yok"
grep -q '"ListingAnalysis"' "$TMP/last" && pass "ListingAnalysis karşılaştırması raporlandı" || fail "ListingAnalysis satırı yok"

left_dbs() { bk psql -X -At -d oto -c "select count(*) from pg_database where datname like 'oto_restore_%'" | tr -d '\r '; }
if [ "$(left_dbs)" = "0" ]; then pass "geçici oto_restore_* DB düşürüldü"; else fail "geçici DB kaldı"; fi

echo "==> restore-test.sh boş / bozuk dump"
run bk sh -c ': >/tmp/empty.dump && restore-test.sh /tmp/empty.dump'
if [ "$RC" -ne 0 ]; then pass "0 baytlık dump → kod $RC"; else fail "0 baytlık dump kabul edildi"; fi
show 2
run bk sh -c 'head -c 8192 /dev/urandom >/tmp/corrupt.dump && restore-test.sh /tmp/corrupt.dump'
if [ "$RC" -ne 0 ]; then pass "bozuk dump → kod $RC"; else fail "bozuk dump kabul edildi"; fi
show 2
# Başlığı geçerli ama gövdesi kesik dump: --list geçebilir, pg_restore başarısız olmalı → trap DB'yi düşürmeli
run bk sh -c 'f=$(ls -1 /backups/daily/oto-*.dump | tail -n 1); s=$(wc -c <"$f"); head -c $((s / 2)) "$f" >/tmp/truncated.dump && restore-test.sh /tmp/truncated.dump'
if [ "$RC" -ne 0 ]; then pass "kesik dump → kod $RC"; else fail "kesik dump kabul edildi"; fi
show 2
run bk restore-test.sh /backups/daily/yok.dump
if [ "$RC" -ne 0 ]; then pass "olmayan dump → kod $RC"; else fail "olmayan dump kabul edildi"; fi
if [ "$(left_dbs)" = "0" ]; then pass "başarısız denemelerden sonra geçici DB kalmadı"; else fail "başarısız denemeden geçici DB kaldı"; fi

echo "==> restore-test.sh kaynakla uyuşmazlık"
run bk psql -X -v ON_ERROR_STOP=1 -d oto -c "insert into _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) values ('backup-check', 'x', 'backup_check_fake', now(), now(), 1)"
run bk restore-test.sh
if [ "$RC" -ne 0 ]; then pass "kaynakta fazladan migration → kod $RC"; else fail "uyuşmazlık yakalanmadı"; fi
show 3
run bk psql -X -v ON_ERROR_STOP=1 -d oto -c "delete from _prisma_migrations where id = 'backup-check'"

# --- 5. Rotasyon -------------------------------------------------------------------------------------------
echo "==> Rotasyon (10 sahte günlük + 6 sahte haftalık)"
bk sh -c 'for i in 01 02 03 04 05 06 07 08 09 10; do echo fake >/backups/daily/oto-202001$i-030000.dump; done
          for i in 05 12 19 26; do echo fake >/backups/weekly/oto-202001$i-030000.dump; done
          for i in 02 09; do echo fake >/backups/weekly/oto-202002$i-030000.dump; done'
before=$(count daily)
# Haftalık kopya günü bugüne çekilir (varsayılan Pazar = 7)
dow=$(bk date +%u | tr -d '\r')
run dc exec -T -u postgres -e BACKUP_WEEKLY_DAY="$dow" backup backup.sh
if [ "$RC" -eq 0 ]; then pass "backup.sh 0 (öncesinde $before günlük)"; else fail "backup.sh kod $RC"; fi
show 12
n=$(count daily)
if [ "$n" = "7" ]; then pass "günlük: 7 kaldı"; else fail "günlük sayısı '$n' (7 bekleniyor)"; fi
n=$(count weekly)
if [ "$n" = "4" ]; then pass "haftalık: 4 kaldı"; else fail "haftalık sayısı '$n' (4 bekleniyor)"; fi
run bk sh -c 'ls -1 /backups/daily | sort'
if grep -q 'oto-20200101-' "$TMP/last" || grep -q 'oto-20200105-' "$TMP/last"; then fail "en eski sahte günlükler silinmedi"; else pass "en eski günlükler silindi"; fi
real=$(grep -c -v '^oto-2020' "$TMP/last" || true)
if [ "$real" = "2" ]; then pass "iki gerçek günlük dump korundu"; else fail "gerçek günlük sayısı '$real'"; fi
run bk sh -c 'f=$(ls -1 /backups/weekly/oto-*.dump | sort | tail -n 1); pg_restore --list "$f" >/dev/null && ls -1 /backups/weekly | sort'
if [ "$RC" -eq 0 ] && ! grep -q 'oto-20200105-\|oto-20200112-' "$TMP/last"; then pass "haftalık kopya geçerli, en eski haftalıklar silindi"; else fail "haftalık rotasyon/kopya"; show; fi
run bk restore-test.sh "$(bk sh -c 'ls -1 /backups/weekly/oto-*.dump | sort | tail -n 1' | tr -d '\r')"
if [ "$RC" -eq 0 ]; then pass "haftalık dump ile restore-test.sh 0"; else fail "haftalık restore-test kod $RC"; show; fi

# --- 6. Başarısız yedek ----------------------------------------------------------------------------------
echo "==> Başarısız pg_dump"
before=$(count daily)
run dc exec -T -u postgres -e PGDATABASE=olmayan_db backup backup.sh
if [ "$RC" -ne 0 ]; then pass "backup.sh başarısızlıkta kod $RC"; else fail "backup.sh başarısızlıkta 0 döndü"; fi
show 3
n=$(count daily)
partial=$(bk sh -c 'ls -A /backups/daily | grep -c partial || true' | tr -d '\r ')
if [ "$n" = "$before" ] && [ "$partial" = "0" ]; then pass "başarısız yedek dosya bırakmadı, rotasyon çalışmadı"; else fail "başarısız yedek sonrası daily=$n partial=$partial"; fi
run bk /usr/local/bin/healthcheck.sh
if [ "$RC" -ne 0 ]; then pass "son çalıştırma başarısız → healthcheck ≠ 0"; else fail "healthcheck başarısız yedeği görmedi"; fi
show 1
run bk backup.sh
run bk /usr/local/bin/healthcheck.sh
if [ "$RC" -eq 0 ]; then pass "başarılı yedek sonrası healthcheck 0"; else fail "healthcheck $RC"; show 2; fi

# --- 7. Gerçek cron yolu: crond → env dosyası → su-exec postgres → backup.sh --------------------------------
echo "==> crond ile zamanlanmış çalıştırma (BACKUP_CRON='* * * * *', en fazla ~80 sn)"
newest() { bk sh -c 'ls -1 /backups/daily | grep -E "^oto-[0-9]{8}-[0-9]{6}\.dump$" | sort | tail -n 1' | tr -d '\r'; }
prev=$(newest)
run env BACKUP_CRON='* * * * *' docker compose -p "$PROJECT" -f docker-compose.yml --env-file "$ENVF" \
  up -d --no-build --no-deps --wait --wait-timeout 60 backup
if [ "$RC" -eq 0 ]; then pass "backup BACKUP_CRON='* * * * *' ile yeniden başladı"; else fail "backup yeniden başlatma (kod $RC)"; show; fi
i=0
cur=$prev
while [ $i -lt 40 ] && [ "$cur" = "$prev" ]; do
  sleep 2
  cur=$(newest)
  i=$((i + 1))
done
if [ "$cur" != "$prev" ]; then pass "crond yeni dump üretti ($cur)"; else fail "crond ~80 sn içinde dump üretmedi"; fi
sleep 3 # işin 'tamam' satırı ve status yazımı
owner=$(dc exec -T backup stat -c '%U %a' "/backups/daily/$cur" | tr -d '\r')
if [ "$owner" = "postgres 600" ]; then pass "cron işi postgres kullanıcısıyla çalıştı (dump: $owner)"; else fail "dump sahibi/izni '$owner'"; fi
if dc logs --no-color backup 2>/dev/null | grep -q "backup: tamam"; then pass "cron işinin çıktısı konteyner loglarında"; else fail "cron iş çıktısı loglarda yok"; fi

# --- 8. Gizli bilgi sızıntısı ----------------------------------------------------------------------------
echo "==> Parola sızıntısı"
dc logs --no-color backup >>"$OUT" 2>&1 || true
dc exec -T backup ps -o args >>"$OUT" 2>&1 || true
if grep -q "$PGPW" "$OUT"; then fail "Postgres parolası çıktı/loglarda görünüyor"; else pass "parola çıktı, log ve süreç argümanlarında yok"; fi
run dc exec -T backup sh -c 'stat -c "%a %U" /run/backup/env'
if [ "$(tr -d '\r' <"$TMP/last")" = "600 root" ]; then pass "cron env dosyası 600 root"; else fail "cron env dosyası izinleri: $(cat "$TMP/last")"; fi

if [ "$FAILS" -gt 0 ]; then
  echo "SONUÇ: FAIL ($FAILS)"
  exit 1
fi
echo "SONUÇ: PASS"
