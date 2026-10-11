#!/usr/bin/env sh
# Oto Fırsat — günlük pg_dump yedeği + rotasyon (backup konteyneri; cron ya da elle).
#
#   docker compose exec -u postgres backup backup.sh
#
# Akış: pg_dump -Fc → <dizin>/.oto-<ts>.dump.partial → boş değil + `pg_restore --list` doğrulaması →
# atomik `mv` → daily/oto-<YYYYmmdd-HHMMSS>.dump. Haftalık gün (BACKUP_WEEKLY_DAY, 1=Pzt..7=Paz; varsayılan 7)
# ayrıca weekly/ altına (hardlink, yoksa kopya) yazılır. Rotasyon yalnız doğrulanmış yeni dump'tan SONRA:
# en yeni BACKUP_KEEP_DAILY (7) günlük + BACKUP_KEEP_WEEKLY (4) haftalık kalır.
# İsteğe bağlı: BACKUP_S3_URI doluysa `aws s3 cp` (aws CLI imajda olmalı: WITH_AWS_CLI=true ile derleme).
#
# Bağlantı: PGHOST/PGPORT/PGUSER/PGDATABASE + PGPASSWORD yalnız ortamdan (komut satırında asla yok,
# hiçbir zaman yazdırılmaz). Herhangi bir hatada sıfır olmayan çıkış ve <dizin>/.last-status = fail.
set -eu
umask 077

DIR=${BACKUP_DIR:-/backups}
KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-4}
WEEKLY_DAY=${BACKUP_WEEKLY_DAY:-7}
STATUS="$DIR/.last-status"

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() {
  log "HATA: $*" >&2
  printf 'fail %s\n' "$(date +%s)" >"$STATUS" 2>/dev/null || true
  exit 1
}
is_uint() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

for v in PGHOST PGUSER PGPASSWORD PGDATABASE; do
  eval "isset=\${$v:+1}"
  [ -n "$isset" ] || die "$v zorunlu (eksik ya da boş)"
done
is_uint "$KEEP_DAILY" && [ "$KEEP_DAILY" -ge 1 ] || die "BACKUP_KEEP_DAILY pozitif tam sayı olmalı"
is_uint "$KEEP_WEEKLY" && [ "$KEEP_WEEKLY" -ge 1 ] || die "BACKUP_KEEP_WEEKLY pozitif tam sayı olmalı"
case "$WEEKLY_DAY" in [1-7]) ;; *) die "BACKUP_WEEKLY_DAY 1-7 olmalı (1=Pazartesi, 7=Pazar)" ;; esac

mkdir -p "$DIR/daily" "$DIR/weekly" || die "$DIR yazılamıyor"

ts=$(date +%Y%m%d-%H%M%S)
name="oto-$ts.dump"
tmp="$DIR/daily/.$name.partial"
wtmp="$DIR/weekly/.$name.partial"
trap 'rm -f "$tmp" "$wtmp"' EXIT
trap 'exit 130' INT TERM

# Önceki çökmüş çalıştırmalardan kalan yarım dosyalar (1 saatten eski)
find "$DIR/daily" "$DIR/weekly" -name '.*.partial' -mmin +60 -type f -exec rm -f {} + 2>/dev/null || true

log "pg_dump başlıyor: $PGDATABASE@$PGHOST -> daily/$name"
start=$(date +%s)
pg_dump --format=custom --compress=6 --no-password --file="$tmp" || die "pg_dump başarısız"
[ -s "$tmp" ] || die "dump boş"
pg_restore --list "$tmp" >/dev/null || die "dump doğrulanamadı (pg_restore --list)"
mv -f "$tmp" "$DIR/daily/$name" || die "dump yerine taşınamadı"
size=$(wc -c <"$DIR/daily/$name" | tr -d ' ')
log "günlük dump hazır: daily/$name ($size bayt, $(($(date +%s) - start)) sn)"

weekly=
if [ "$(date +%u)" = "$WEEKLY_DAY" ]; then
  # Aynı gün içinde ikinci çalıştırma haftalık kopyayı çoğaltmasın: o güne ait eski haftalık yerine geçer.
  find "$DIR/weekly" -name "oto-$(date +%Y%m%d)-*.dump" -type f -exec rm -f {} + 2>/dev/null || true
  ln "$DIR/daily/$name" "$wtmp" 2>/dev/null || cp "$DIR/daily/$name" "$wtmp" || die "haftalık kopya yazılamadı"
  mv -f "$wtmp" "$DIR/weekly/$name" || die "haftalık kopya taşınamadı"
  weekly="$DIR/weekly/$name"
  log "haftalık kopya: weekly/$name"
fi

# Rotasyon: yalnız oto-YYYYmmdd-HHMMSS.dump adları; ad sırası = zaman sırası, en yeni N tanesi kalır.
rotate() {
  ls -1 "$1" | grep -E '^oto-[0-9]{8}-[0-9]{6}\.dump$' | sort -r | tail -n +"$(($2 + 1))" | while read -r f; do
    rm -f "$1/$f"
    log "rotasyon: $(basename "$1")/$f silindi"
  done
}
rotate "$DIR/daily" "$KEEP_DAILY"
rotate "$DIR/weekly" "$KEEP_WEEKLY"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  command -v aws >/dev/null 2>&1 || die "BACKUP_S3_URI ayarlı ama aws CLI imajda yok (WITH_AWS_CLI=true ile derleyin ya da rclone yan konteyneri kullanın; docs/operations/backup-restore.md)"
  dest=${BACKUP_S3_URI%/}
  aws s3 cp --only-show-errors "$DIR/daily/$name" "$dest/daily/$name" || die "S3 yüklemesi başarısız (daily/$name)"
  if [ -n "$weekly" ]; then
    aws s3 cp --only-show-errors "$weekly" "$dest/weekly/$name" || die "S3 yüklemesi başarısız (weekly/$name)"
  fi
  log "S3'e yüklendi: daily/$name${weekly:+ + weekly/$name}"
fi

printf 'ok %s %s\n' "$(date +%s)" "$name" >"$STATUS"
log "tamam"
