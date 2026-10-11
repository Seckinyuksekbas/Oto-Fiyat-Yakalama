#!/usr/bin/env sh
# Yedekleme + geri yükleme testinin uçtan uca doğrulaması (Plan 08 Task 10).
#
#   sh scripts/backup-restore-check.sh
#
# docker-compose.yml'den yalnız postgres + migrate (seed'li) + backup servisleri, ayrı bir compose projesi
# (oto-backup-check) olarak ayağa kalkar; ayrıca geri yükleme hedefi olarak atılabilir bir postgres:16-alpine yan
# konteyneri (restoredb) backend ağına bağlanır. Uygulama imajları DERLENMEZ (mevcut migrate imajı kullanılır);
# yalnız backup imajı derlenir. backup servisi compose'daki sertleştirmeyle (cap_drop ALL + SETUID/SETGID/CHOWN,
# no-new-privileges, tmpfs) çalışır. Kontroller:
#   1. backup healthy; crond, TZ, crontab, tmpfs, yetkiler
#   2. backup.sh → dump + aynı anlık görüntüden sayım manifesti (.counts)
#   3. restore-test.sh → ayrı sunucuya (restoredb) 0; üretim koruması (hedef = kaynak, onaysız) → 2
#   4. boş / bozuk / kesik / olmayan dump → 1; geçici DB kalmaz
#   5. manifest: kaynak değişse de 0; bozuk manifest → 1; manifestsiz → 1; canlı karşılaştırma uyuşmazlığı → 1
#   6. root ile `exec` → postgres'e düşer (dump sahibi postgres); restore-test root ile de çalışır
#   7. rotasyon: 10 sahte günlük + 6 sahte haftalık → 7 + 4; .counts dump'ıyla birlikte silinir
#   8. başarısız pg_dump → 1, dosya kalmaz, healthcheck ≠ 0; eski dump / bayat .last-status → healthcheck ≠ 0
#   9. kilit: eşzamanlı ikinci yedek temiz biçimde 1 döner, ilk çalıştırmanın geçici dosyaları kalır, ilki başarılı
#      biter; yedek sürerken restore-test kilidi bekler
#  10. gerçek cron yolu (BACKUP_CRON='* * * * *'): crond → env dosyası → su-exec postgres → backup.sh
#  11. parolalar log, çıktı ve (yedek sürerken alınan) süreç argümanlarında görünmez
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
SIDECAR="$PROJECT-restoredb"
MIGRATE_IMAGE="${OTO_IMAGE_PREFIX:-oto}/migrate:${OTO_TAG:-latest}"
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
# üretim sunucusuna (kaynak) bilerek geri yükleme: hata yolu testleri için
rt_prod() { dc exec -T -u postgres -e RESTORE_TEST_ON_PROD=1 backup restore-test.sh "$@"; }
# atılabilir yan sunucuya geri yükleme (parola komut satırına değil, ortamdan aktarılır)
rt_side() { dc exec -T -u postgres -e RESTORE_PGHOST=restoredb -e RESTORE_PGUSER=postgres -e RESTORE_PGPASSWORD backup restore-test.sh "$@"; }
# komutu çalıştırır, çıktısını $TMP/last'a ve $OUT'a yazar, çıkış kodunu $RC'ye koyar
run() {
  set +e
  "$@" >"$TMP/last" 2>&1
  RC=$?
  set -e
  cat "$TMP/last" >>"$OUT"
}
show() { sed 's/^/      | /' "$TMP/last" | tail -n "${1:-8}"; }
last() { tr -d '\r' <"$TMP/last"; }
count() { bk sh -c "ls -1 /backups/$1 2>/dev/null | grep -cE '^oto-[0-9]{8}-[0-9]{6}\\.$2\$' || true" | tr -d '\r '; }
newest() { bk sh -c 'ls -1 /backups/daily | grep -E "^oto-[0-9]{8}-[0-9]{6}\.dump$" | sort | tail -n 1' | tr -d '\r'; }
left_dbs() { bk psql -X -At -d oto -c "select count(*) from pg_database where datname like 'oto_restore_%'" | tr -d '\r '; }
side_dbs() { docker exec -u postgres "$SIDECAR" psql -X -At -c "select count(*) from pg_database where datname like 'oto_restore_%'" | tr -d '\r '; }

cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ -f "$ENVF" ]; then
    if [ "$code" -ne 0 ] || [ "$FAILS" -gt 0 ]; then
      echo "==> Hata ayıklama: servis durumu ve son loglar"
      dc ps -a 2>/dev/null || true
      dc logs --no-color --tail 30 backup 2>/dev/null || true
    fi
    echo "==> Kapanış: yan sunucu + docker compose down -v"
    docker rm -f -v "$SIDECAR" >/dev/null 2>&1 || true
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
if ! docker image inspect "$MIGRATE_IMAGE" >/dev/null 2>&1; then
  echo "FAIL $MIGRATE_IMAGE imajı yok (önce: docker compose build migrate)"
  exit 1
fi

# --- 0. Geçici env (compose interpolasyonu için tüm zorunlular; yalnız postgres/migrate/backup çalışır) ------
echo "==> $ENVF üretiliyor"
PGPW=$(rand_hex 16)
RPW=$(rand_hex 16)
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
echo "POSTGRES_PASSWORD=$RPW" >"$TMP/restoredb.env"
umask 022
# Yan sunucu parolası hiçbir komut satırına girmez: compose exec `-e RESTORE_PGPASSWORD` değeri bu ortamdan alır.
export RESTORE_PGPASSWORD="$RPW"

# --- 1. Ayağa kaldırma: postgres → migrate (+seed) → backup; yan sunucu ----------------------------------------
echo "==> backup imajı derleniyor (yalnız backup)"
run dc build backup
if [ "$RC" -eq 0 ]; then pass "backup imajı derlendi"; else fail "backup derlemesi (kod $RC)"; show 20; exit 1; fi

echo "==> postgres + migrate (seed) + backup (proje: $PROJECT)"
run dc up -d --no-build --wait --wait-timeout 120 postgres
if [ "$RC" -eq 0 ]; then pass "postgres healthy"; else fail "postgres up (kod $RC)"; show 20; exit 1; fi
run dc run --rm --no-deps -T migrate
if [ "$RC" -eq 0 ]; then pass "migrate + seed tamamlandı"; else fail "migrate (kod $RC)"; show 20; exit 1; fi
run dc up -d --no-build --no-deps --wait --wait-timeout 120 backup
if [ "$RC" -eq 0 ]; then pass "backup servisi healthy"; else fail "backup up --wait (kod $RC)"; show 20; exit 1; fi

echo "==> Atılabilir geri yükleme sunucusu ($SIDECAR, backend ağında 'restoredb')"
run docker run -d --name "$SIDECAR" --network "${PROJECT}_backend" --network-alias restoredb \
  --env-file "$TMP/restoredb.env" postgres:16-alpine
i=0
until docker exec "$SIDECAR" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 60 ] || break
  sleep 1
done
if [ $i -lt 60 ]; then pass "yan sunucu hazır"; else fail "yan sunucu açılmadı"; exit 1; fi

echo "==> Konfigürasyon ve sertleştirme"
user=$(dc exec -T backup sh -c 'ps -o user,comm | awk "\$2==\"crond\"{print \$1}"' | tr -d '\r')
[ -n "$user" ] && pass "crond çalışıyor (kullanıcı: $user)" || fail "crond çalışmıyor"
tz=$(bk date +%z | tr -d '\r')
if [ "$tz" = "+0300" ]; then pass "TZ Europe/Istanbul (+0300)"; else fail "saat dilimi ofseti '$tz'"; fi
cron=$(dc exec -T backup cat /etc/crontabs/root | grep -v '^#' | tr -d '\r')
case "$cron" in
  "0 3 * * * "*backup.sh*) pass "crontab: varsayılan BACKUP_CRON '0 3 * * *'" ;;
  *) fail "crontab beklenmiyor: '$cron'" ;;
esac
run dc exec -T backup sh -c 'grep " /run/backup " /proc/mounts'
case "$(last)" in tmpfs*) pass "/run/backup tmpfs" ;; *) fail "/run/backup tmpfs değil: $(last)" ;; esac
run dc exec -T backup sh -c 'grep -E "^(CapEff|NoNewPrivs)" /proc/1/status'
# SETUID(7) SETGID(6) CHOWN(0) = 0xc1
if grep -q 'CapEff:.*00000000000000c1' "$TMP/last" && grep -q 'NoNewPrivs:.*1' "$TMP/last"; then
  pass "yetkiler yalnız CHOWN+SETGID+SETUID, no-new-privileges açık"
else
  fail "yetkiler/no-new-privileges: $(last | tr '\n' ' ')"
fi
run dc exec -T backup /usr/local/bin/healthcheck.sh
if [ "$RC" -eq 0 ]; then pass "healthcheck (root → postgres) 0: hiç dump yok, açılış payı"; else fail "healthcheck $RC"; show; fi

# --- 2. Elle yedek -------------------------------------------------------------------------------------
echo "==> backup.sh (elle tetikleme)"
run bk backup.sh
if [ "$RC" -eq 0 ]; then pass "backup.sh 0"; else fail "backup.sh kod $RC"; fi
show 5
n=$(count daily dump)
if [ "$n" = "1" ]; then pass "daily/ altında 1 dump"; else fail "daily dump sayısı '$n' (1 bekleniyor)"; fi
cur=$(newest)
run bk cat "/backups/daily/${cur%.dump}.counts"
if grep -qx 'migrations=16' "$TMP/last" && grep -qx 'unfinished=0' "$TMP/last" && grep -qx 'User=1' "$TMP/last" &&
  grep -qx 'Listing=0' "$TMP/last" && grep -qx 'ListingAnalysis=0' "$TMP/last"; then
  pass "sayım manifesti: $(grep -v '^#' "$TMP/last" | tr -d '\r' | tr '\n' ' ')"
else
  fail "sayım manifesti beklenmiyor"
  show
fi
run bk sh -c 'ls -A /backups/daily | grep -c "^\.oto-" || true'
if [ "$(last)" = "0" ]; then pass "geçici dosya (.partial/fifo/snap) kalmadı"; else fail "geçici dosya kaldı"; fi
run bk sh -c 'f=$(ls -1 /backups/daily/oto-*.dump | tail -n 1); pg_restore --list "$f" | grep -c "TABLE DATA"'
if [ "$RC" -eq 0 ] && [ "$(last)" -gt 0 ]; then pass "dump pg_restore --list ile okunuyor ($(last) TABLE DATA)"; else fail "dump okunamadı"; show; fi

# --- 3. Geri yükleme testi: ayrı sunucu + üretim koruması ------------------------------------------------------
echo "==> restore-test.sh → atılabilir yan sunucu (restoredb)"
run rt_side
if [ "$RC" -eq 0 ]; then pass "restore-test.sh (yan sunucu) 0"; else fail "restore-test.sh (yan sunucu) kod $RC"; fi
show 10
grep -q 'karşılaştırma: manifest' "$TMP/last" && pass "manifestle karşılaştırıldı" || fail "manifest modu kullanılmadı"
grep -q '(restoredb:5432)' "$TMP/last" && pass "hedef yan sunucu" || fail "hedef yan sunucu değil"
if [ "$(side_dbs)" = "0" ]; then pass "yan sunucuda geçici DB düşürüldü"; else fail "yan sunucuda geçici DB kaldı"; fi
if [ "$(left_dbs)" = "0" ]; then pass "kaynak sunucuda geçici DB oluşturulmadı"; else fail "kaynakta geçici DB var"; fi

echo "==> Üretim koruması"
run bk restore-test.sh
if [ "$RC" -eq 2 ]; then pass "hedef = kaynak (RESTORE_PGHOST yok), onaysız → kod 2"; else fail "onaysız üretim geri yüklemesi kod $RC (2 bekleniyor)"; fi
show 3
run dc exec -T -u postgres -e RESTORE_PGHOST=postgres backup restore-test.sh
if [ "$RC" -eq 2 ]; then pass "RESTORE_PGHOST=postgres (aynı system_identifier), onaysız → kod 2"; else fail "aynı sunucu farklı adla kod $RC"; fi
run rt_prod
if [ "$RC" -eq 0 ]; then pass "RESTORE_TEST_ON_PROD=1 ile kaynak sunucuda 0"; else fail "RESTORE_TEST_ON_PROD=1 kod $RC"; show; fi
if [ "$(left_dbs)" = "0" ]; then pass "geçici oto_restore_* DB düşürüldü"; else fail "geçici DB kaldı"; fi

# --- 4. Hatalı dump'lar ------------------------------------------------------------------------------------
echo "==> restore-test.sh boş / bozuk / kesik / olmayan dump"
run bk sh -c ': >/tmp/empty.dump'
run rt_prod /tmp/empty.dump
if [ "$RC" -eq 1 ]; then pass "0 baytlık dump → kod 1"; else fail "0 baytlık dump kod $RC"; fi
show 2
run bk sh -c 'head -c 8192 /dev/urandom >/tmp/corrupt.dump'
run rt_prod /tmp/corrupt.dump
if [ "$RC" -eq 1 ]; then pass "bozuk dump → kod 1"; else fail "bozuk dump kod $RC"; fi
show 2
run bk sh -c 'f=$(ls -1 /backups/daily/oto-*.dump | tail -n 1); s=$(wc -c <"$f"); head -c $((s / 2)) "$f" >/tmp/truncated.dump; cp "${f%.dump}.counts" /tmp/truncated.counts'
run rt_prod /tmp/truncated.dump
if [ "$RC" -eq 1 ]; then pass "kesik dump → kod 1"; else fail "kesik dump kod $RC"; fi
show 2
run rt_prod /backups/daily/yok.dump
if [ "$RC" -eq 1 ]; then pass "olmayan dump → kod 1"; else fail "olmayan dump kod $RC"; fi
if [ "$(left_dbs)" = "0" ]; then pass "başarısız denemelerden sonra geçici DB kalmadı"; else fail "başarısız denemeden geçici DB kaldı"; fi

# --- 5. Manifest ---------------------------------------------------------------------------------------------
echo "==> Sayım manifesti"
run bk psql -X -v ON_ERROR_STOP=1 -d oto -c "insert into _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) values ('backup-check', 'x', 'backup_check_fake', now(), now(), 1)"
run rt_side
if [ "$RC" -eq 0 ]; then pass "kaynak dump'tan sonra değişti, manifestle yine 0"; else fail "kaynak değişince manifestli test kod $RC"; show 4; fi
run bk sh -c 'f=$(ls -1 /backups/daily/oto-*.dump | tail -n 1); cp "$f" /tmp/nomanifest.dump; cp "$f" /tmp/tampered.dump; sed "s/^User=.*/User=999/" "${f%.dump}.counts" >/tmp/tampered.counts'
run rt_side /tmp/tampered.dump
if [ "$RC" -eq 1 ] && grep -q 'FAIL User' "$TMP/last"; then pass "manifestle uyuşmazlık (User=999) → kod 1"; else fail "manifest uyuşmazlığı yakalanmadı (kod $RC)"; show 4; fi
run rt_side /tmp/nomanifest.dump
if [ "$RC" -eq 1 ] && grep -q 'RESTORE_TEST_LIVE_COMPARE' "$TMP/last"; then pass "manifestsiz dump → kod 1 (canlı karşılaştırma açık onay ister)"; else fail "manifestsiz dump kod $RC"; show 3; fi
run dc exec -T -u postgres \
  -e RESTORE_PGHOST=restoredb -e RESTORE_PGUSER=postgres -e RESTORE_PGPASSWORD -e RESTORE_TEST_LIVE_COMPARE=1 \
  backup restore-test.sh /tmp/nomanifest.dump
if [ "$RC" -eq 1 ] && grep -q 'FAIL migrations' "$TMP/last"; then pass "RESTORE_TEST_LIVE_COMPARE=1: kaynakta fazladan migration → kod 1"; else fail "canlı karşılaştırma uyuşmazlığı kod $RC"; show 4; fi
run bk psql -X -v ON_ERROR_STOP=1 -d oto -c "delete from _prisma_migrations where id = 'backup-check'"
run dc exec -T -u postgres \
  -e RESTORE_PGHOST=restoredb -e RESTORE_PGUSER=postgres -e RESTORE_PGPASSWORD -e RESTORE_TEST_LIVE_COMPARE=1 \
  backup restore-test.sh /tmp/nomanifest.dump
if [ "$RC" -eq 0 ]; then pass "RESTORE_TEST_LIVE_COMPARE=1: kaynak eşitken 0"; else fail "canlı karşılaştırma kod $RC"; show 4; fi

# --- 6. root ile exec -------------------------------------------------------------------------------------------
echo "==> root ile exec (varsayılan kullanıcı)"
prev=$(newest)
sleep 1
run dc exec -T backup backup.sh
if [ "$RC" -eq 0 ]; then pass "root ile backup.sh 0"; else fail "root ile backup.sh kod $RC"; show; fi
cur=$(newest)
owner=$(bk stat -c '%U %a' "/backups/daily/$cur" "/backups/daily/${cur%.dump}.counts" | tr -d '\r' | sort -u | tr '\n' ' ')
if [ "$cur" != "$prev" ] && [ "$owner" = "postgres 600 " ]; then pass "root çağrısı postgres'e düştü (dump + manifest: $owner)"; else fail "dump sahibi/izni '$owner' ($cur)"; fi
run dc exec -T -e RESTORE_TEST_ON_PROD=1 backup restore-test.sh
if [ "$RC" -eq 0 ]; then pass "root ile restore-test.sh 0"; else fail "root ile restore-test.sh kod $RC"; show; fi
run bk sh -c 'find /backups ! -user postgres | head -5'
if [ -z "$(last)" ]; then pass "/backups altında postgres'e ait olmayan dosya yok"; else fail "root'a ait dosyalar: $(last | tr '\n' ' ')"; fi

# --- 7. Rotasyon -------------------------------------------------------------------------------------------
echo "==> Rotasyon (10 sahte günlük + 6 sahte haftalık, manifestleriyle)"
bk sh -c 'for i in 01 02 03 04 05 06 07 08 09 10; do echo fake >/backups/daily/oto-202001$i-030000.dump; echo fake >/backups/daily/oto-202001$i-030000.counts; done
          for i in 05 12 19 26; do echo fake >/backups/weekly/oto-202001$i-030000.dump; echo fake >/backups/weekly/oto-202001$i-030000.counts; done
          for i in 02 09; do echo fake >/backups/weekly/oto-202002$i-030000.dump; echo fake >/backups/weekly/oto-202002$i-030000.counts; done
          echo fake >/backups/daily/oto-20190101-000000.counts'
before=$(count daily dump)
# Haftalık kopya günü bugüne çekilir (varsayılan Pazar = 7)
dow=$(bk date +%u | tr -d '\r')
run dc exec -T -u postgres -e BACKUP_WEEKLY_DAY="$dow" backup backup.sh
if [ "$RC" -eq 0 ]; then pass "backup.sh 0 (öncesinde $before günlük)"; else fail "backup.sh kod $RC"; fi
show 12
n=$(count daily dump)
if [ "$n" = "7" ]; then pass "günlük: 7 dump kaldı"; else fail "günlük dump sayısı '$n' (7 bekleniyor)"; fi
n=$(count daily counts)
if [ "$n" = "7" ]; then pass "günlük: 7 manifest kaldı (silinen dump'ların manifesti + yetim manifest silindi)"; else fail "günlük manifest sayısı '$n' (7 bekleniyor)"; fi
n=$(count weekly dump)
if [ "$n" = "4" ]; then pass "haftalık: 4 dump kaldı"; else fail "haftalık dump sayısı '$n' (4 bekleniyor)"; fi
n=$(count weekly counts)
if [ "$n" = "4" ]; then pass "haftalık: 4 manifest kaldı"; else fail "haftalık manifest sayısı '$n' (4 bekleniyor)"; fi
run bk sh -c 'ls -1 /backups/daily | sort'
if grep -qE 'oto-2020010[1-5]-' "$TMP/last"; then fail "en eski sahte günlükler silinmedi"; else pass "en eski günlükler silindi"; fi
real=$(grep -cE '^oto-2026.*\.dump' "$TMP/last" || true)
if [ "$real" = "3" ]; then pass "üç gerçek günlük dump korundu"; else fail "gerçek günlük sayısı '$real'"; fi
run bk sh -c 'f=$(ls -1 /backups/weekly/oto-*.dump | sort | tail -n 1); pg_restore --list "$f" >/dev/null && ls -1 /backups/weekly | sort'
if [ "$RC" -eq 0 ] && ! grep -qE 'oto-202001(05|12|19)-' "$TMP/last"; then pass "haftalık kopya geçerli, en eski haftalıklar silindi"; else fail "haftalık rotasyon/kopya"; show; fi
wk=$(bk sh -c 'ls -1 /backups/weekly/oto-*.dump | sort | tail -n 1' | tr -d '\r')
run rt_side "$wk"
if [ "$RC" -eq 0 ]; then pass "haftalık dump (manifestiyle) restore-test.sh 0"; else fail "haftalık restore-test kod $RC"; show; fi

# --- 8. Başarısız yedek + healthcheck ---------------------------------------------------------------------
echo "==> Başarısız pg_dump ve healthcheck"
before=$(count daily dump)
run dc exec -T -u postgres -e PGDATABASE=olmayan_db backup backup.sh
if [ "$RC" -eq 1 ]; then pass "backup.sh başarısızlıkta kod 1"; else fail "backup.sh başarısızlıkta kod $RC"; fi
show 3
n=$(count daily dump)
tmpf=$(bk sh -c 'ls -A /backups/daily | grep -c "^\.oto-" || true' | tr -d '\r ')
if [ "$n" = "$before" ] && [ "$tmpf" = "0" ]; then pass "başarısız yedek dosya bırakmadı, rotasyon çalışmadı"; else fail "başarısız yedek sonrası daily=$n geçici=$tmpf"; fi
run bk cat /backups/.last-status
case "$(last)" in fail*) pass "EXIT trap .last-status = fail yazdı" ;; *) fail ".last-status: $(last)" ;; esac
run dc exec -T backup /usr/local/bin/healthcheck.sh
if [ "$RC" -ne 0 ]; then pass "son çalıştırma başarısız → healthcheck ≠ 0"; else fail "healthcheck başarısız yedeği görmedi"; fi
show 1
run bk backup.sh
run dc exec -T backup /usr/local/bin/healthcheck.sh
if [ "$RC" -eq 0 ]; then pass "başarılı yedek sonrası healthcheck 0"; else fail "healthcheck $RC"; show 2; fi
# Eski dump: açılış payı (konteyner yeni) dump varken uygulanmamalı
run bk sh -c 'mkdir -p /tmp/hc1/daily && touch -d "2020-01-01 00:00:00" /tmp/hc1/daily/oto-20200101-000000.dump && BACKUP_DIR=/tmp/hc1 /usr/local/bin/healthcheck.sh'
if [ "$RC" -ne 0 ]; then pass "yalnız eski dump var (konteyner yeni açılmış olsa da) → healthcheck ≠ 0"; else fail "eski dump açılış payıyla sağlıklı sayıldı"; fi
show 1
run bk sh -c 'mkdir -p /tmp/hc2/daily && : >/tmp/hc2/daily/oto-20990101-000000.dump && echo "ok 1000000000 x" >/tmp/hc2/.last-status && BACKUP_DIR=/tmp/hc2 /usr/local/bin/healthcheck.sh'
if [ "$RC" -ne 0 ]; then pass "bayat .last-status → healthcheck ≠ 0"; else fail "bayat .last-status sağlıklı sayıldı"; fi
show 1

# --- 9. Kilit: eşzamanlı çalıştırma ------------------------------------------------------------------------------
echo "==> Kilit (eşzamanlı ikinci yedek)"
# "User" tablosunu 15 sn kilitleyen oturum: 1. yedek sayım aşamasında bekler (geçici dosyaları açık, kilit onda)
dc exec -T -u postgres backup psql -X -q -d oto -c 'begin; lock table "User" in access exclusive mode; select pg_sleep(15); commit;' \
  </dev/null >/dev/null 2>&1 &
LOCKER=$!
sleep 2
dc exec -T -u postgres backup backup.sh </dev/null >"$TMP/first.out" 2>&1 &
FIRST=$!
i=0
until bk sh -c 'ls -A /backups/daily | grep -q "^\.oto-"' 2>/dev/null; do
  i=$((i + 1))
  [ $i -lt 20 ] || break
  sleep 0.5
done
first_tmp=$(bk sh -c 'ls -A /backups/daily | grep "^\.oto-" | sort' | tr -d '\r' | tr '\n' ' ')
[ -n "$first_tmp" ] && pass "1. yedek sürüyor (geçici: $first_tmp)" || fail "1. yedeğin geçici dosyaları görünmedi"
# Yedek sürerken süreç argümanları (parola komut satırında olmamalı; aşağıda taranır)
dc exec -T backup ps -o args >>"$OUT" 2>&1 || true
run bk backup.sh
if [ "$RC" -eq 1 ] && grep -q 'başka bir yedek' "$TMP/last"; then pass "eşzamanlı 2. yedek → kod 1, açık mesaj"; else fail "2. yedek kod $RC"; fi
show 1
after_tmp=$(bk sh -c 'ls -A /backups/daily | grep "^\.oto-" | sort' | tr -d '\r' | tr '\n' ' ')
if [ -n "$first_tmp" ] && [ "$after_tmp" = "$first_tmp" ]; then pass "1. yedeğin geçici dosyaları yerinde"; else fail "geçici dosyalar değişti: '$first_tmp' → '$after_tmp'"; fi
st=$(bk cat /backups/.last-status | tr -d '\r')
case "$st" in ok*) pass "kilit çakışması .last-status'u bozmadı ($st)" ;; *) fail ".last-status: $st" ;; esac
run dc exec -T -u postgres -e RESTORE_TEST_ON_PROD=1 -e RESTORE_TEST_LOCK_WAIT=1 backup restore-test.sh
if [ "$RC" -eq 1 ] && grep -q 'kilidi' "$TMP/last"; then pass "yedek sürerken restore-test kilidi bekler (1 sn) → kod 1"; else fail "restore-test kilit kod $RC"; show 2; fi
set +e
wait "$FIRST"
first_rc=$?
wait "$LOCKER"
set -e
cat "$TMP/first.out" >>"$OUT"
if [ "$first_rc" -eq 0 ] && grep -q 'backup: tamam' "$TMP/first.out"; then pass "1. yedek kilit kalkınca başarıyla bitti"; else fail "1. yedek kod $first_rc"; sed 's/^/      | /' "$TMP/first.out" | tail -n 4; fi
tmpf=$(bk sh -c 'ls -A /backups/daily | grep -c "^\.oto-" || true' | tr -d '\r ')
[ "$tmpf" = "0" ] && pass "1. yedek sonrası geçici dosya kalmadı" || fail "geçici dosya kaldı ($tmpf)"

# --- 10. Gerçek cron yolu: crond → env dosyası → su-exec postgres → backup.sh --------------------------------
echo "==> crond ile zamanlanmış çalıştırma (BACKUP_CRON='* * * * *', en fazla ~80 sn; sertleştirilmiş yetkilerle)"
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
owner=$(bk stat -c '%U %a' "/backups/daily/$cur" | tr -d '\r')
if [ "$owner" = "postgres 600" ]; then pass "cron işi postgres kullanıcısıyla çalıştı (dump: $owner)"; else fail "dump sahibi/izni '$owner'"; fi
if dc logs --no-color backup 2>/dev/null | grep -q "backup: tamam"; then pass "cron işinin çıktısı konteyner loglarında"; else fail "cron iş çıktısı loglarda yok"; fi

# --- 11. Gizli bilgi sızıntısı ----------------------------------------------------------------------------
echo "==> Parola sızıntısı"
dc logs --no-color backup >>"$OUT" 2>&1 || true
if grep -q -e "$PGPW" -e "$RPW" "$OUT"; then fail "bir parola çıktı/loglarda/süreç argümanlarında görünüyor"; else pass "parolalar çıktı, log ve (yedek sürerken) süreç argümanlarında yok"; fi
run dc exec -T backup sh -c 'stat -c "%a %U" /run/backup/env'
if [ "$(last)" = "600 root" ]; then pass "cron env dosyası 600 root (tmpfs)"; else fail "cron env dosyası izinleri: $(last)"; fi

if [ "$FAILS" -gt 0 ]; then
  echo "SONUÇ: FAIL ($FAILS)"
  exit 1
fi
echo "SONUÇ: PASS"
