#!/usr/bin/env sh
# backup healthcheck: crond çalışıyor, son çalıştırma başarısız değil ve son günlük dump BACKUP_MAX_AGE_MIN'den
# (varsayılan 1560 dk = 26 saat) yeni. Henüz hiç taze dump yoksa açılıştan sonraki ilk 26 saat sağlıklı sayılır
# (ilk gece yedeğinden önce konteyner unhealthy olmasın).
set -eu
DIR=${BACKUP_DIR:-/backups}
MAX=${BACKUP_MAX_AGE_MIN:-1560}

if ! pgrep -x crond >/dev/null 2>&1; then
  echo "crond çalışmıyor"
  exit 1
fi
if [ -f "$DIR/.last-status" ] && grep -q '^fail' "$DIR/.last-status"; then
  echo "son yedek çalıştırması başarısız (docker compose logs backup)"
  exit 1
fi
if find "$DIR/daily" -name 'oto-*.dump' -type f -mmin "-$MAX" 2>/dev/null | grep -q .; then
  exit 0
fi
started=$(cat /run/backup/started 2>/dev/null || echo 0)
if [ $(($(date +%s) - started)) -lt $((MAX * 60)) ]; then
  exit 0
fi
echo "son $MAX dakikada günlük dump yok"
exit 1
