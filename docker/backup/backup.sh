#!/usr/bin/env sh
# Oto Fırsat — günlük pg_dump yedeği + sayım manifesti + rotasyon (backup konteyneri; cron ya da elle).
#
#   docker compose exec backup backup.sh        (root ile çağrılırsa kendini postgres kullanıcısına düşürür)
#
# Akış:
#   1. `$DIR/.lock` üzerinde dışlayıcı flock (-n): başka bir yedek ya da geri yükleme testi sürüyorsa açık mesajla
#      çıkış 1 (diğer çalıştırmanın geçici dosyalarına dokunulmaz, .last-status değişmez).
#   2. Tek bir psql oturumu REPEATABLE READ salt-okunur transaction açar, `pg_export_snapshot()` ile anlık görüntüyü
#      dışa verir ve AYNI anlık görüntüde sayımları okur (_prisma_migrations toplam/bitmemiş, "User", "Listing",
#      "ListingAnalysis"). pg_dump `--snapshot` ile tam olarak bu anlık görüntüden döker: manifest dump ile birebir
#      tutarlıdır (canlı yazmalardan etkilenmez). Oturum dump bitene kadar açık kalır.
#   3. pg_dump -Fc → .partial → boş değil + `pg_restore --list` → atomik `mv`:
#      daily/oto-<YYYYmmdd-HHMMSS>.dump + daily/oto-<ts>.counts (manifest önce taşınır).
#   4. Haftalık gün (BACKUP_WEEKLY_DAY, 1=Pzt..7=Paz; varsayılan 7) weekly/ altına hardlink (yoksa kopya).
#   5. Rotasyon yalnız doğrulanmış yeni dump'tan SONRA: en yeni BACKUP_KEEP_DAILY (7) günlük + BACKUP_KEEP_WEEKLY (4)
#      haftalık; .counts dosyası dump'ıyla birlikte silinir.
#   6. İsteğe bağlı: BACKUP_S3_URI doluysa `aws s3 cp` (aws CLI imajda olmalı: WITH_AWS_CLI=true ile derleme).
#
# Bağlantı: PGHOST/PGPORT/PGUSER/PGDATABASE + PGPASSWORD yalnız ortamdan (komut satırında asla yok, hiçbir zaman
# yazdırılmaz). Herhangi bir hatada çıkış 1 ve <dizin>/.last-status = fail (kilit çakışması hariç).
set -eu
umask 077

# root ile çağrıldıysa (`docker compose exec backup ...` varsayılanı) dump'lar root'a ait olmasın: postgres'e düş.
if [ "$(id -u)" = 0 ] && command -v su-exec >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  exec su-exec postgres "$0" "$@"
fi

DIR=${BACKUP_DIR:-/backups}
KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-4}
WEEKLY_DAY=${BACKUP_WEEKLY_DAY:-7}
STATUS="$DIR/.last-status"
LOCK_BUSY=0
TMPFILES=
SNAP_PID=

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() {
  log "HATA: $*" >&2
  exit 1
}
is_uint() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

on_exit() {
  code=$?
  trap - EXIT
  if [ -n "$SNAP_PID" ]; then
    exec 8>&-
    kill "$SNAP_PID" 2>/dev/null || true
    wait "$SNAP_PID" 2>/dev/null || true
  fi
  # shellcheck disable=SC2086 # dosya adlarında boşluk yok
  [ -z "$TMPFILES" ] || rm -f $TMPFILES
  if [ "$code" -ne 0 ] && [ "$LOCK_BUSY" -eq 0 ]; then
    printf 'fail %s\n' "$(date +%s)" >"$STATUS" 2>/dev/null || true
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

for v in PGHOST PGUSER PGPASSWORD PGDATABASE; do
  eval "isset=\${$v:+1}"
  [ -n "$isset" ] || die "$v zorunlu (eksik ya da boş)"
done
is_uint "$KEEP_DAILY" && [ "$KEEP_DAILY" -ge 1 ] || die "BACKUP_KEEP_DAILY pozitif tam sayı olmalı"
is_uint "$KEEP_WEEKLY" && [ "$KEEP_WEEKLY" -ge 1 ] || die "BACKUP_KEEP_WEEKLY pozitif tam sayı olmalı"
case "$WEEKLY_DAY" in [1-7]) ;; *) die "BACKUP_WEEKLY_DAY 1-7 olmalı (1=Pazartesi, 7=Pazar)" ;; esac

mkdir -p "$DIR/daily" "$DIR/weekly" || die "$DIR yazılamıyor"

# --- 1. Kilit ------------------------------------------------------------------------------------------------
exec 9>>"$DIR/.lock" || die "$DIR/.lock açılamıyor"
if ! flock -n 9; then
  LOCK_BUSY=1
  log "HATA: başka bir yedek ya da geri yükleme testi çalışıyor ($DIR/.lock tutuluyor); bu çalıştırma atlandı" >&2
  exit 1
fi
# Kilit bizde: başka çalıştırma yok, kalan geçici dosyalar çökmüş çalıştırmalardandır.
find "$DIR/daily" "$DIR/weekly" -name '.oto-*' -type f -exec rm -f {} + 2>/dev/null || true
find "$DIR/daily" -name '.oto-*' -type p -exec rm -f {} + 2>/dev/null || true

# Zaman damgası, haftanın günü ve tarih tek `date` çağrısından (gece yarısı sınırında tutarlı).
# shellcheck disable=SC2046
set -- $(date '+%Y%m%d-%H%M%S %u %Y%m%d')
ts=$1 dow=$2 day=$3
base="oto-$ts"
name="$base.dump"
tmp="$DIR/daily/.$base.dump.partial"
ctmp="$DIR/daily/.$base.counts.partial"
fifo="$DIR/daily/.$base.fifo"
snapout="$DIR/daily/.$base.snap"
wtmp="$DIR/weekly/.$base.dump.partial"
wctmp="$DIR/weekly/.$base.counts.partial"
TMPFILES="$tmp $ctmp $fifo $snapout $wtmp $wctmp"

# --- 2. Anlık görüntü + sayım manifesti ---------------------------------------------------------------------
log "anlık görüntü + sayımlar: $PGDATABASE@$PGHOST"
mkfifo -m 600 "$fifo" || die "fifo oluşturulamadı"
psql -X -q -At -v ON_ERROR_STOP=1 --no-password <"$fifo" >"$snapout" 2>&1 &
SNAP_PID=$!
exec 8>"$fifo"
cat >&8 <<'SQL'
begin transaction isolation level repeatable read read only;
select 'snapshot=' || pg_export_snapshot();
select 'migrations=' || count(*) from _prisma_migrations;
select 'unfinished=' || count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null;
select 'User=' || count(*) from "User";
select 'Listing=' || count(*) from "Listing";
select 'ListingAnalysis=' || count(*) from "ListingAnalysis";
select 'counts=done';
SQL
i=0
until grep -q '^counts=done$' "$snapout" 2>/dev/null; do
  kill -0 "$SNAP_PID" 2>/dev/null || die "anlık görüntü oturumu başarısız: $(head -c 300 "$snapout")"
  i=$((i + 1))
  # Uzun süren tablo kilitlerinde (migration vb.) en fazla BACKUP_SNAPSHOT_WAIT sn bekler
  [ "$i" -le $((${BACKUP_SNAPSHOT_WAIT:-300} * 10)) ] || die "anlık görüntü oturumu ${BACKUP_SNAPSHOT_WAIT:-300} sn içinde yanıt vermedi"
  sleep 0.1
done
snap=$(sed -n 's/^snapshot=//p' "$snapout")
[ -n "$snap" ] || die "anlık görüntü kimliği alınamadı"
{
  echo "# $name ile aynı anlık görüntü (pg_export_snapshot + pg_dump --snapshot)"
  grep -E '^(migrations|unfinished|User|Listing|ListingAnalysis)=[0-9]+$' "$snapout"
} >"$ctmp"
[ "$(grep -c '=' "$ctmp")" = "5" ] || die "sayım manifesti eksik"

# --- 3. Dump + doğrulama + atomik taşıma ---------------------------------------------------------------------
log "pg_dump başlıyor -> daily/$name"
start=$(date +%s)
pg_dump --format=custom --compress=6 --no-password --snapshot="$snap" --file="$tmp" || die "pg_dump başarısız"
printf 'commit;\n' >&8
exec 8>&-
wait "$SNAP_PID" || die "anlık görüntü oturumu hatayla kapandı"
SNAP_PID=
[ -s "$tmp" ] || die "dump boş"
pg_restore --list "$tmp" >/dev/null || die "dump doğrulanamadı (pg_restore --list)"
mv -f "$ctmp" "$DIR/daily/$base.counts" || die "manifest yerine taşınamadı"
mv -f "$tmp" "$DIR/daily/$name" || die "dump yerine taşınamadı"
size=$(wc -c <"$DIR/daily/$name" | tr -d ' ')
log "günlük dump hazır: daily/$name ($size bayt, $(($(date +%s) - start)) sn); manifest: $(grep -v '^#' "$DIR/daily/$base.counts" | tr '\n' ' ')"

# --- 4. Haftalık kopya ------------------------------------------------------------------------------------
weekly=
if [ "$dow" = "$WEEKLY_DAY" ]; then
  # Aynı gün içinde ikinci çalıştırma haftalık kopyayı çoğaltmasın: o güne ait eski haftalık yerine geçer.
  find "$DIR/weekly" \( -name "oto-$day-*.dump" -o -name "oto-$day-*.counts" \) -type f -exec rm -f {} + 2>/dev/null || true
  ln "$DIR/daily/$base.counts" "$wctmp" 2>/dev/null || cp "$DIR/daily/$base.counts" "$wctmp" || die "haftalık manifest yazılamadı"
  ln "$DIR/daily/$name" "$wtmp" 2>/dev/null || cp "$DIR/daily/$name" "$wtmp" || die "haftalık kopya yazılamadı"
  mv -f "$wctmp" "$DIR/weekly/$base.counts" || die "haftalık manifest taşınamadı"
  mv -f "$wtmp" "$DIR/weekly/$name" || die "haftalık kopya taşınamadı"
  weekly="$DIR/weekly/$name"
  log "haftalık kopya: weekly/$name"
fi

# --- 5. Rotasyon: yalnız oto-YYYYmmdd-HHMMSS.dump adları; ad sırası = zaman sırası, en yeni N tanesi kalır ------
rotate() {
  ls -1 "$1" | grep -E '^oto-[0-9]{8}-[0-9]{6}\.dump$' | sort -r | tail -n +"$(($2 + 1))" | while read -r f; do
    rm -f "$1/$f" "$1/${f%.dump}.counts"
    log "rotasyon: $(basename "$1")/$f silindi"
  done
  # dump'ı olmayan (yetim) manifestler
  for c in "$1"/oto-*.counts; do
    [ -e "$c" ] || continue
    [ -e "${c%.counts}.dump" ] || rm -f "$c"
  done
}
rotate "$DIR/daily" "$KEEP_DAILY"
rotate "$DIR/weekly" "$KEEP_WEEKLY"

# --- 6. İsteğe bağlı S3 -------------------------------------------------------------------------------------
if [ -n "${BACKUP_S3_URI:-}" ]; then
  command -v aws >/dev/null 2>&1 || die "BACKUP_S3_URI ayarlı ama aws CLI imajda yok (WITH_AWS_CLI=true ile derleyin ya da rclone yan konteyneri kullanın; docs/operations/backup-restore.md)"
  dest=${BACKUP_S3_URI%/}
  for f in "$name" "$base.counts"; do
    aws s3 cp --only-show-errors "$DIR/daily/$f" "$dest/daily/$f" || die "S3 yüklemesi başarısız (daily/$f)"
    if [ -n "$weekly" ]; then
      aws s3 cp --only-show-errors "$DIR/weekly/$f" "$dest/weekly/$f" || die "S3 yüklemesi başarısız (weekly/$f)"
    fi
  done
  log "S3'e yüklendi: daily/$name${weekly:+ + weekly/$name} (+ .counts)"
fi

printf 'ok %s %s\n' "$(date +%s)" "$name" >"$STATUS"
log "tamam"
