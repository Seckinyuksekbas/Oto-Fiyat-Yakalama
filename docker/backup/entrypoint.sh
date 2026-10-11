#!/usr/bin/env sh
# backup konteyneri açılışı: env doğrulaması → cron env dosyası → crontab (BACKUP_CRON) → busybox crond (ön planda).
# Hata mesajları değişken adını söyler, değerini (parola) asla yazdırmaz.
set -eu
umask 077

for v in PGHOST PGUSER PGPASSWORD PGDATABASE; do
  eval "isset=\${$v:+1}"
  if [ -z "$isset" ]; then
    echo "backup: $v zorunlu (eksik ya da boş)" >&2
    exit 1
  fi
done

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
  echo "backup: BACKUP_CRON geçersiz: 5 alanlı sayısal cron ifadesi olmalı (ör. '0 3 * * *')" >&2
  exit 1
fi

# busybox crond işleri temiz bir ortamla çalıştırır: bağlantı/yedek değişkenleri root'a ait 0600 bir dosyaya
# (tmpfs değil ama konteynerin kendi katmanı; volume'e yazılmaz) tek tırnakla kaçışlanarak yazılır, iş satırı onu
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
date +%s >/run/backup/started && chmod 644 /run/backup/started # gizli değil; healthcheck postgres kullanıcısıyla da okunabilsin
mkdir -p /backups/daily /backups/weekly
chown postgres:postgres /backups /backups/daily /backups/weekly

echo "backup: zamanlama '$BACKUP_CRON' (TZ=${TZ:-UTC}); saklama: ${BACKUP_KEEP_DAILY:-7} günlük + ${BACKUP_KEEP_WEEKLY:-4} haftalık${BACKUP_S3_URI:+; S3 hedefi ayarlı}"
# -f: ön plan, -d 6: stderr'e bilgi düzeyinde log (iş başlangıçları), -c: crontab dizini
exec crond -f -d 6 -c /etc/crontabs
