# Oto Fırsat — gece pg_dump yedeği (busybox crond) + rotasyon + geri yükleme testi.
# Taban postgres:16-alpine: pg_dump/pg_restore sunucuyla aynı ana sürüm (16); busybox crond, su-exec ve tzdata
# imajda zaten var. Sır içermez: bağlantı bilgileri yalnız çalışma anında env ile gelir.
#
#   docker compose build backup
#   docker compose build --build-arg WITH_AWS_CLI=true backup   # BACKUP_S3_URI kullanılacaksa (+~100 MB)
FROM postgres:16-alpine

# İsteğe bağlı S3 yüklemesi için aws CLI. Varsayılan kapalı: python3 bağımlılığıyla imajı belirgin büyütür; önerilen yol rclone yan
# konteyneridir (docs/operations/backup-restore.md). Gizli değil, yalnız paket seçimi.
ARG WITH_AWS_CLI=false
RUN if [ "$WITH_AWS_CLI" = "true" ]; then apk add --no-cache aws-cli; fi

COPY --chmod=755 docker/backup/backup.sh /usr/local/bin/backup.sh
COPY --chmod=755 docker/backup/entrypoint.sh /usr/local/bin/backup-entrypoint.sh
COPY --chmod=755 docker/backup/healthcheck.sh /usr/local/bin/healthcheck.sh
COPY --chmod=755 scripts/restore-test.sh /usr/local/bin/restore-test.sh
# --chmod yok: BuildKit, COPY ile oluşan üst dizine de aynı kipi verir (644 → x biti yok); DAC yetkisi olmayan root
# /etc/backup içine giremezdi. Kaynak dosya zaten 0644.
COPY docker/backup/crontab /etc/backup/crontab

# /backups volume'ü ilk bağlandığında bu sahipliği devralır: dump'ları yalnız postgres kullanıcısı yazar/okur.
RUN mkdir -p /backups/daily /backups/weekly /run/backup \
  && chown -R postgres:postgres /backups \
  && chmod 700 /backups /backups/daily /backups/weekly
VOLUME ["/backups"]

ENV TZ=Europe/Istanbul \
  BACKUP_DIR=/backups

# USER root bilinçli: busybox crond işleri crontab sahibinin kimliğine geçmek için setuid/setgid/initgroups çağırır
# ve root olmadan iş çalıştıramaz. Yetki alanı dar tutulur: root yalnız crond'u ve env/crontab dosyalarını yönetir;
# yedek işi `su-exec postgres` ile ayrıcalıksız çalışır, dump'lar postgres:postgres 0600. Elle çalıştırma da
# `docker compose exec -u postgres backup ...` ile yapılır. Konteynerin dışa portu yok, yalnız iç `backend` ağında.
USER root

HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --start-interval=2s --retries=2 \
  CMD ["/usr/local/bin/healthcheck.sh"]
# Taban imajın postgres'e özgü ayarları sıfırlanır (SIGINT/`postgres` komutu crond için anlamsız).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/backup-entrypoint.sh"]
CMD []
