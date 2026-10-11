#!/usr/bin/env sh
# backup healthcheck. Sağlıklı sayılması için:
#   - crond çalışıyor
#   - .last-status `fail` değil ve son başarılı çalıştırma BACKUP_MAX_AGE_MIN'den (varsayılan 1560 dk = 26 saat) yeni
#   - en yeni günlük dump BACKUP_MAX_AGE_MIN'den yeni
# Açılış payı YALNIZ hiç oto-*.dump yokken geçerlidir (ilk kurulum: ilk gece yedeğinden önce unhealthy olmasın);
# dump'lar varsa her zaman en yenisinin yaşına bakılır.
set -eu

# root ile çağrılır (Docker healthcheck): yedek dizini postgres:postgres 0700, okumak için postgres'e düş
# (root'a DAC_OVERRIDE/DAC_READ_SEARCH yetkisi verilmez).
if [ "$(id -u)" = 0 ] && command -v su-exec >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  exec su-exec postgres "$0" "$@"
fi

DIR=${BACKUP_DIR:-/backups}
MAX=${BACKUP_MAX_AGE_MIN:-1560}
case "$MAX" in '' | *[!0-9]*) echo "BACKUP_MAX_AGE_MIN pozitif tam sayı olmalı"; exit 1 ;; esac
now=$(date +%s)

if ! pgrep -x crond >/dev/null 2>&1; then
  echo "crond çalışmıyor"
  exit 1
fi

if [ -f "$DIR/.last-status" ]; then
  read -r st when _ <"$DIR/.last-status" || true
  if [ "${st:-}" = "fail" ]; then
    echo "son yedek çalıştırması başarısız (docker compose logs backup)"
    exit 1
  fi
  case "${when:-}" in '' | *[!0-9]*) echo ".last-status okunamıyor"; exit 1 ;; esac
  if [ $((now - when)) -ge $((MAX * 60)) ]; then
    echo "son başarılı yedek $(((now - when) / 60)) dk önce (sınır $MAX dk)"
    exit 1
  fi
fi

if ls -1 "$DIR/daily" 2>/dev/null | grep -qE '^oto-[0-9]{8}-[0-9]{6}\.dump$'; then
  if find "$DIR/daily" -name 'oto-*.dump' -type f -mmin "-$MAX" 2>/dev/null | grep -q .; then
    exit 0
  fi
  echo "en yeni günlük dump $MAX dakikadan eski"
  exit 1
fi

# Hiç dump yok: açılıştan sonraki BACKUP_MAX_AGE_MIN dakika sağlıklı (ilk gece öncesi)
started=$(cat /run/backup/started 2>/dev/null || echo 0)
if [ $((now - started)) -lt $((MAX * 60)) ]; then
  exit 0
fi
echo "hiç günlük dump yok (açılıştan $(((now - started) / 60)) dk geçti)"
exit 1
