#!/usr/bin/env sh
# backup konteyneri açılışı: env doğrulaması → cron env dosyası → crontab (BACKUP_CRON) → busybox crond (ön planda).
# Hata mesajları değişken adını söyler, değerini (parola) asla yazdırmaz. Ayar hatası açılışta yakalanır (gece
# yedeği anında değil).
set -eu
umask 077

err() {
  echo "backup: $*" >&2
  exit 1
}
is_uint() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

for v in PGHOST PGUSER PGPASSWORD PGDATABASE; do
  eval "isset=\${$v:+1}"
  [ -n "$isset" ] || err "$v zorunlu (eksik ya da boş)"
done
is_uint "${BACKUP_KEEP_DAILY:-7}" && [ "${BACKUP_KEEP_DAILY:-7}" -ge 1 ] || err "BACKUP_KEEP_DAILY pozitif tam sayı olmalı"
is_uint "${BACKUP_KEEP_WEEKLY:-4}" && [ "${BACKUP_KEEP_WEEKLY:-4}" -ge 1 ] || err "BACKUP_KEEP_WEEKLY pozitif tam sayı olmalı"
case "${BACKUP_WEEKLY_DAY:-7}" in [1-7]) ;; *) err "BACKUP_WEEKLY_DAY 1-7 olmalı (1=Pazartesi, 7=Pazar)" ;; esac
is_uint "${BACKUP_MAX_AGE_MIN:-1560}" && [ "${BACKUP_MAX_AGE_MIN:-1560}" -ge 60 ] ||
  err "BACKUP_MAX_AGE_MIN en az 60 olan tam sayı (dakika) olmalı"

# BACKUP_CRON: 5 alanlı, yalnız sayı ve * / , - içeren cron ifadesi (crontab'a enjeksiyon olmasın).
BACKUP_CRON=${BACKUP_CRON:-0 3 * * *}
set -f
# shellcheck disable=SC2086
set -- $BACKUP_CRON
set +f
case "$BACKUP_CRON" in
  *[!0-9*/,\ -]*) bad=1 ;;
  *) bad=0 ;;
esac
if [ "$bad" -eq 1 ] || [ "$#" -ne 5 ]; then
  err "BACKUP_CRON geçersiz: 5 alanlı sayısal cron ifadesi olmalı (ör. '0 3 * * *')"
fi

# busybox crond işleri temiz bir ortamla çalıştırır: bağlantı/yedek değişkenleri /run/backup (compose'da tmpfs;
# diske ve volume'e yazılmaz) altında root'a ait 0600 bir dosyaya tek tırnakla kaçışlanarak yazılır, iş satırı onu
# okur. Değerler hiçbir zaman loglanmaz.
mkdir -p /run/backup
ENVFILE=/run/backup/env
: >"$ENVFILE"
chmod 600 "$ENVFILE"
for v in $(env | grep -E '^(PG[A-Z]+|BACKUP_[A-Z0-9_]+|AWS_[A-Z0-9_]+|TZ)=' | cut -d= -f1 | sort -u); do
  eval "val=\${$v:-}"
  # shellcheck disable=SC2154
  esc=$(printf '%s' "$val" | sed "s/'/'\\\\''/g")
  printf "export %s='%s'\n" "$v" "$esc" >>"$ENVFILE"
done

sed "s|@BACKUP_CRON@|$BACKUP_CRON|" /etc/backup/crontab >/etc/crontabs/root
date +%s >/run/backup/started && chmod 644 /run/backup/started # gizli değil; healthcheck postgres kullanıcısıyla okur

# Yedek dizini postgres'e ait olmalı (CHOWN yetkisi); alt dizinleri postgres kendisi oluşturur — root'a dosya izinlerini
# aşma yetkisi (DAC_OVERRIDE) verilmez.
chown postgres:postgres /backups
su-exec postgres mkdir -p /backups/daily /backups/weekly

echo "backup: zamanlama '$BACKUP_CRON' (TZ=${TZ:-UTC}); saklama: ${BACKUP_KEEP_DAILY:-7} günlük + ${BACKUP_KEEP_WEEKLY:-4} haftalık${BACKUP_S3_URI:+; S3 hedefi ayarlı}"
# -f: ön plan, -d 6: stderr'e bilgi düzeyinde log (iş başlangıçları), -c: crontab dizini
exec crond -f -d 6 -c /etc/crontabs
