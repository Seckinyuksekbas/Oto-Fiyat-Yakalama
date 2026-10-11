#!/usr/bin/env sh
# Oto Fırsat — otomatik geri yükleme testi: bir pg_dump yedeğinin gerçekten geri yüklenebildiğini doğrular.
# Spec §6: aylık, elle çalıştırılır (zamanlanmaz).
#
#   # Önerilen: ayrı, atılabilir bir Postgres sunucusuna (üretim DB'sine CPU/disk yükü bindirmez)
#   docker compose --env-file .env.prod exec -e RESTORE_PGHOST=<sunucu> -e RESTORE_PGUSER=<kullanıcı> \
#     -e RESTORE_PGPASSWORD backup restore-test.sh [dump]
#   # Üretim sunucusunun kendisine (geçici DB): açık onay gerekir
#   docker compose --env-file .env.prod exec -e RESTORE_TEST_ON_PROD=1 backup restore-test.sh [dump]
#
# Varsayılan dump: en son günlük. Dump geçici `oto_restore_<ts>` veritabanına geri yüklenir (tek transaction, ilk
# hatada durur) ve doğrulanır:
#   - geri yüklenen DB'de bitmemiş migration yok (finished_at NULL ve geri alınmamış)
#   - `_prisma_migrations`, "User", "Listing", "ListingAnalysis" satır sayıları dump'ın sayım manifestiyle
#     (oto-<ts>.counts; backup.sh dump ile AYNI anlık görüntüden yazar) birebir aynı
#   - manifest yoksa yalnız RESTORE_TEST_LIVE_COMPARE=1 ile kaynak DB'nin (PGDATABASE) o anki sayılarıyla
#     karşılaştırılır (canlı sistemde yazmalar yüzünden yanlış alarm verebilir)
# Hedef sunucu: RESTORE_PGHOST / RESTORE_PGPORT / RESTORE_PGUSER / RESTORE_PGPASSWORD (verilmezse kaynak sunucu;
# RESTORE_PGHOST verildiyse kaynak parolası oraya GÖNDERİLMEZ). Hedef kaynakla aynı sunucuysa (system_identifier,
# okunamazsa host:port) RESTORE_TEST_ON_PROD=1 olmadan çıkış 2.
# Yedek kilidi (`$BACKUP_DIR/.lock`) paylaşımlı alınır: test sürerken backup.sh rotasyonu dump'ı silemez; yedek
# sürüyorsa en fazla RESTORE_TEST_LOCK_WAIT (600) sn beklenir.
# Geçici DB her durumda (trap) düşürülür. Çıkış: 0 = doğrulandı, 1 = başarısız (boş/bozuk/kesik dump, geri yükleme
# hatası, manifest yok ya da sayı uyuşmazlığı), 2 = hedef üretim sunucusu ve onay yok. Parola yazdırılmaz.
set -eu

# root ile çağrıldıysa (`docker compose exec backup ...` varsayılanı) postgres kullanıcısına düş.
if [ "$(id -u)" = 0 ] && command -v su-exec >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  exec su-exec postgres "$0" "$@"
fi

DIR=${BACKUP_DIR:-/backups}
TMPDB=
FAILED=0

log() { printf '%s restore-test: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() {
  log "HATA: $*" >&2
  exit 1
}

for v in PGHOST PGUSER PGPASSWORD PGDATABASE; do
  eval "isset=\${$v:+1}"
  [ -n "$isset" ] || die "$v zorunlu (eksik ya da boş)"
done

# Hedef sunucu bağlantısı (alt kabukta export: parola hiçbir komut satırına girmez)
R_HOST=${RESTORE_PGHOST:-$PGHOST}
R_PORT=${RESTORE_PGPORT:-${PGPORT:-5432}}
R_USER=${RESTORE_PGUSER:-$PGUSER}
if [ -n "${RESTORE_PGHOST:-}" ]; then R_PW=${RESTORE_PGPASSWORD:-}; else R_PW=$PGPASSWORD; fi
R_MAINT=${RESTORE_PGMAINTDB:-postgres}
tgt() (
  export PGHOST="$R_HOST" PGPORT="$R_PORT" PGUSER="$R_USER" PGPASSWORD="$R_PW"
  "$@"
)

cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ -n "$TMPDB" ]; then
    if tgt dropdb --if-exists --force --no-password --maintenance-db="$R_MAINT" "$TMPDB" 2>/dev/null; then
      log "geçici veritabanı düşürüldü: $TMPDB ($R_HOST)"
    else
      log "UYARI: geçici veritabanı düşürülemedi: $TMPDB ($R_HOST; elle: dropdb $TMPDB)" >&2
      [ "$code" -ne 0 ] || code=1
    fi
  fi
  [ "$code" -eq 0 ] || [ "$code" -eq 2 ] || code=1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Yedek kilidi (paylaşımlı): dump seçimi ve geri yükleme boyunca rotasyon dump'ı silemez.
if [ -d "$DIR" ] && [ -w "$DIR" ]; then
  exec 9>>"$DIR/.lock"
  wait_s=${RESTORE_TEST_LOCK_WAIT:-600}
  case "$wait_s" in '' | *[!0-9]*) die "RESTORE_TEST_LOCK_WAIT saniye (tam sayı) olmalı" ;; esac
  # busybox flock'ta -w yok: engellemeyen deneme + 1 sn bekleme
  waited=0
  until flock -s -n 9; do
    [ "$waited" -lt "$wait_s" ] || die "yedek kilidi $wait_s sn içinde alınamadı ($DIR/.lock: yedek sürüyor)"
    [ "$waited" -gt 0 ] || log "yedek sürüyor, kilit bekleniyor (en fazla $wait_s sn)"
    sleep 1
    waited=$((waited + 1))
  done
fi

dump=${1:-}
if [ -z "$dump" ]; then
  latest=$(ls -1 "$DIR/daily" 2>/dev/null | grep -E '^oto-[0-9]{8}-[0-9]{6}\.dump$' | sort | tail -n 1 || true)
  [ -n "$latest" ] || die "$DIR/daily altında yedek yok"
  dump="$DIR/daily/$latest"
fi
[ -f "$dump" ] || die "dump bulunamadı: $dump"
[ -s "$dump" ] || die "dump boş (0 bayt): $dump"
pg_restore --list "$dump" >/dev/null 2>&1 || die "dump okunamıyor ya da bozuk (pg_restore --list): $dump"

manifest="${dump%.dump}.counts"
if [ -f "$manifest" ]; then
  mode=manifest
elif [ "${RESTORE_TEST_LIVE_COMPARE:-0}" = "1" ]; then
  mode=live
  log "UYARI: manifest yok, kaynak DB'nin canlı sayılarıyla karşılaştırılıyor (RESTORE_TEST_LIVE_COMPARE=1)"
else
  die "sayım manifesti yok ($manifest); kaynak DB ile canlı karşılaştırma için RESTORE_TEST_LIVE_COMPARE=1"
fi
[ -z "${RESTORE_TEST_ALLOW_GROWTH:-}" ] ||
  log "UYARI: RESTORE_TEST_ALLOW_GROWTH kaldırıldı ve yok sayılıyor (manifest dump ile aynı anlık görüntüden yazılır)"

# Üretim koruması: hedef kaynakla aynı sunucuysa açık onay iste.
sysid() { psql -X -At --no-password -d "$1" -c 'select system_identifier from pg_control_system()' 2>/dev/null || true; }
same_server() {
  [ -n "${RESTORE_PGHOST:-}" ] || return 0
  src_id=$(sysid "$PGDATABASE")
  dst_id=$(tgt sysid "$R_MAINT")
  if [ -n "$src_id" ] && [ -n "$dst_id" ]; then
    [ "$src_id" = "$dst_id" ]
    return
  fi
  [ "$R_HOST" = "$PGHOST" ] && [ "$R_PORT" = "${PGPORT:-5432}" ]
}
if same_server && [ "${RESTORE_TEST_ON_PROD:-0}" != "1" ]; then
  log "HATA: geri yükleme hedefi kaynak (üretim) sunucusunun kendisi ($R_HOST:$R_PORT). Geri yükleme orada CPU, disk ve" >&2
  log "      bağlantı tüketir. Ayrı, atılabilir bir sunucu için RESTORE_PGHOST/RESTORE_PGPORT/RESTORE_PGUSER/" >&2
  log "      RESTORE_PGPASSWORD verin ya da bilerek üretimde çalıştırmak için RESTORE_TEST_ON_PROD=1." >&2
  exit 2
fi

TMPDB="oto_restore_$(date +%Y%m%d%H%M%S)_$$"
log "geri yükleniyor: $dump -> $TMPDB ($R_HOST:$R_PORT)"
tgt createdb --no-password --maintenance-db="$R_MAINT" --template=template0 "$TMPDB" || {
  TMPDB=
  die "geçici veritabanı oluşturulamadı ($R_HOST:$R_PORT; CREATEDB yetkisi gerekir)"
}
start=$(date +%s)
tgt pg_restore --no-password --no-owner --no-privileges --exit-on-error --single-transaction \
  --dbname="$TMPDB" "$dump" || die "pg_restore başarısız"
log "geri yükleme tamam ($(($(date +%s) - start)) sn); karşılaştırma: $mode"

q() { psql -X -q -At -v ON_ERROR_STOP=1 --no-password -d "$1" -c "$2"; }
expected() { # expected <anahtar> <sql>
  if [ "$mode" = manifest ]; then
    v=$(sed -n "s/^$1=//p" "$manifest")
    case "$v" in '' | *[!0-9]*) die "manifest bozuk ya da '$1' eksik: $manifest" ;; esac
    printf '%s' "$v"
  else
    q "$PGDATABASE" "$2" || die "kaynak sorgusu başarısız: $1"
  fi
}
check() { # check <anahtar> <sql>
  exp=$(expected "$1" "$2")
  got=$(tgt q "$TMPDB" "$2") || die "geri yüklenen DB sorgusu başarısız: $1"
  if [ "$exp" = "$got" ]; then
    log "OK   $1: geri yüklenen=$got beklenen=$exp"
  else
    log "FAIL $1: geri yüklenen=$got beklenen=$exp ($mode)" >&2
    FAILED=1
  fi
}

unfinished=$(tgt q "$TMPDB" 'select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null') ||
  die "migration durumu okunamadı"
if [ "$unfinished" = "0" ]; then
  log "OK   bitmemiş migration yok"
else
  log "FAIL bitmemiş migration: $unfinished" >&2
  FAILED=1
fi
check migrations 'select count(*) from _prisma_migrations'
check User 'select count(*) from "User"'
check Listing 'select count(*) from "Listing"'
check ListingAnalysis 'select count(*) from "ListingAnalysis"'

[ "$FAILED" -eq 0 ] || die "doğrulama başarısız: $dump"
log "BAŞARILI: $dump geri yüklenebilir ve manifestle tutarlı ($mode)"
