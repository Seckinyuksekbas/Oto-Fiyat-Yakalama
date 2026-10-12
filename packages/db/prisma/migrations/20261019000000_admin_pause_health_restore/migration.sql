-- Plan 08 Task 6: yönetici duraklatması artık yalnız isActive=false yazar; health=PAUSED yalnızca engel sinyali demektir.
-- Plan 07'de POST /admin/sources/:id/pause ayrıca health=PAUSED yazıyordu. Bu kaynaklar engelli kaynaklardan ancak
-- denetim kaydıyla ayırt edilebilir; yalnızca şu koşulların HEPSİ sağlanınca duraklatma öncesi sağlığa döndürülür:
--   * kaynak etkin değil ve health=PAUSED;
--   * kaynağın son duraklat/etkinleştir denetim satırı `source.pause`;
--   * o satırın before.health değeri engel değil (HEALTHY/DEGRADED/DOWN): engelli kaynağı duraklatmak engeli silmez;
--   * duraklatmadan sonra hata görülmemiş (lastErrorAt <= denetim zamanı): uçuştaki bir iş engellenmiş olabilir.
-- Koşulu sağlamayan PAUSED satırlara dokunulmaz (engel varsayılır; yönetici nedeni inceleyip etkinleştirir).
-- Koşullu olduğundan yeniden çalıştırmak güvenlidir.
WITH last_toggle AS (
  SELECT DISTINCT ON (a."targetId") a."targetId", a.action, a.before, a."createdAt"
  FROM "AuditLog" a
  WHERE a."targetType" = 'DataSource' AND a.action IN ('source.pause', 'source.activate')
  ORDER BY a."targetId", a."createdAt" DESC, a.id DESC
)
UPDATE "DataSource" s
SET health = (t.before ->> 'health')::"SourceHealth",
    "updatedAt" = now()
FROM last_toggle t
WHERE t."targetId" = s.id::text
  AND t.action = 'source.pause'
  AND s."isActive" = false
  AND s.health = 'PAUSED'
  AND t.before ->> 'health' IN ('HEALTHY', 'DEGRADED', 'DOWN')
  AND (s."lastErrorAt" IS NULL OR s."lastErrorAt" <= t."createdAt");
