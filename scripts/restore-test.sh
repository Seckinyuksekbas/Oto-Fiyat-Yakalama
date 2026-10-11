#!/usr/bin/env sh
# Oto Fırsat — otomatik geri yükleme testi: bir pg_dump yedeğinin gerçekten geri yüklenebildiğini doğrular.
#
#   docker compose --env-file .env.prod exec -u postgres backup restore-test.sh            (en son günlük dump)
#   docker compose --env-file .env.prod exec -u postgres backup restore-test.sh /backups/weekly/oto-....dump
#
# Dump'ı geçici `oto_restore_<ts>` veritabanına geri yükler (tek transaction, ilk hatada durur) ve kaynak DB
# (PGDATABASE) ile karşılaştırır:
#   - `_prisma_migrations` satır sayısı aynı ve geri yüklenen DB'de bitmemiş (finished_at NULL, geri alınmamış)
#     migration yok
#   - "User" / "Listing" / "ListingAnalysis" satır sayıları aynı
#     (RESTORE_TEST_ALLOW_GROWTH=1: canlı sistemde dump'tan sonra eklenen satırlar için geri yüklenen ≤ kaynak
#     kabul edilir; migration sayısı her zaman birebir karşılaştırılır)
# Geçici DB her durumda (trap) düşürülür. Çıkış: 0 = geri yükleme doğrulandı, 1 = başarısız (boş/bozuk/kesik dump,
# geri yükleme hatası ya da sayı uyuşmazlığı). Bağlantı yalnız PG* ortam değişkenlerinden; parola yazdırılmaz.
# Gereken yetki: CREATEDB (compose'daki POSTGRES_USER süper kullanıcıdır).
set -eu

DIR=${BACKUP_DIR:-/backups}
SRC_DB=${PGDATABASE:-}
TMPDB=
FAILED=0

log() { printf '%s restore-test: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() {
  log "HATA: $*" >&2
  exit 1
}

cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ -n "$TMPDB" ]; then
    if dropdb --if-exists --force --no-password --maintenance-db="$SRC_DB" "$TMPDB" 2>/dev/null; then
      log "geçici veritabanı düşürüldü: $TMPDB"
    else
      log "UYARI: geçici veritabanı düşürülemedi: $TMPDB (elle: dropdb $TMPDB)" >&2
      code=1
    fi
  fi
  [ "$code" -eq 0 ] || code=1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

for v in PGHOST PGUSER PGPASSWORD PGDATABASE; do
  eval "isset=\${$v:+1}"
  [ -n "$isset" ] || die "$v zorunlu (eksik ya da boş)"
done

dump=${1:-}
if [ -z "$dump" ]; then
  latest=$(ls -1 "$DIR/daily" 2>/dev/null | grep -E '^oto-[0-9]{8}-[0-9]{6}\.dump$' | sort | tail -n 1 || true)
  [ -n "$latest" ] || die "$DIR/daily altında yedek yok"
  dump="$DIR/daily/$latest"
fi
[ -f "$dump" ] || die "dump bulunamadı: $dump"
[ -s "$dump" ] || die "dump boş (0 bayt): $dump"
pg_restore --list "$dump" >/dev/null 2>&1 || die "dump okunamıyor ya da bozuk (pg_restore --list): $dump"

TMPDB="oto_restore_$(date +%Y%m%d%H%M%S)_$$"
log "geri yükleniyor: $dump -> $TMPDB"
createdb --no-password --maintenance-db="$SRC_DB" --template=template0 "$TMPDB" || {
  TMPDB=
  die "geçici veritabanı oluşturulamadı"
}
start=$(date +%s)
pg_restore --no-password --no-owner --no-privileges --exit-on-error --single-transaction \
  --dbname="$TMPDB" "$dump" || die "pg_restore başarısız"
log "geri yükleme tamam ($(($(date +%s) - start)) sn)"

q() { psql -X -q -At -v ON_ERROR_STOP=1 --no-password -d "$1" -c "$2"; }
check() { # check <etiket> <sql> <kural: eq|le>
  src=$(q "$SRC_DB" "$2") || die "kaynak sorgusu başarısız: $1"
  dst=$(q "$TMPDB" "$2") || die "geri yüklenen DB sorgusu başarısız: $1"
  ok=0
  if [ "$src" = "$dst" ]; then ok=1; elif [ "$3" = le ] && [ "$dst" -le "$src" ]; then ok=1; fi
  if [ "$ok" -eq 1 ]; then
    log "OK   $1: geri yüklenen=$dst kaynak=$src"
  else
    log "FAIL $1: geri yüklenen=$dst kaynak=$src" >&2
    FAILED=1
  fi
}

rule=eq
[ "${RESTORE_TEST_ALLOW_GROWTH:-0}" = "1" ] && rule=le

check _prisma_migrations 'select count(*) from _prisma_migrations' eq
unfinished=$(q "$TMPDB" 'select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null') ||
  die "migration durumu okunamadı"
if [ "$unfinished" = "0" ]; then
  log "OK   bitmemiş migration yok"
else
  log "FAIL bitmemiş migration: $unfinished" >&2
  FAILED=1
fi
for t in '"User"' '"Listing"' '"ListingAnalysis"'; do
  check "$t" "select count(*) from $t" "$rule"
done

[ "$FAILED" -eq 0 ] || die "doğrulama başarısız: $dump"
log "BAŞARILI: $dump geri yüklenebilir ve kaynakla tutarlı"
