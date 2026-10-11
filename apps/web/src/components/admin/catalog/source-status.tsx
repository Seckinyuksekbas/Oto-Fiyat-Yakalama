import { StatusBadge } from '@/components/admin/status-badge';

/**
 * İki ayrı duraklatma:
 * - **Yönetici duraklatması** yalnız `isActive=false` yazar; sağlık olduğu gibi kalır, dry-run çalışır, alarm yok.
 * - **Engel** (403/captcha/robots) `health=PAUSED` yapar; dry-run dahil hiçbir istek atılmaz, etkinleştirme sıfırlar.
 */
export const ADMIN_PAUSED_LABEL = 'Duraklatıldı (yönetici)';
export const SCHEDULE_OFF_LABEL = 'Zamanlama kapalı';
export const BLOCK_PAUSED_LABEL = 'Engel nedeniyle duraklatıldı';
export const BLOCK_PAUSED_COPY = 'Engel sinyali (403, captcha, robots) alındı; istek atılmıyor. Nedeni inceleyip etkinleştirin.';

export const isBlockPaused = (s: { health: string }) => s.health === 'PAUSED';

/**
 * Sağlık rozeti (engelde "Engel nedeniyle duraklatıldı") + etkin değilse ayrı rozet: izni doğrulanmışsa
 * "Duraklatıldı (yönetici)", doğrulanmamışsa (hiç etkinleştirilemez) nötr "Zamanlama kapalı". İkisi birlikte görünebilir.
 */
export function SourceStatusBadges({ source }: { source: { health: string; isActive: boolean; permissionVerifiedAt: string | null } }) {
  return (
    <>
      {isBlockPaused(source) ? <StatusBadge status="PAUSED" label={BLOCK_PAUSED_LABEL} tone="danger" /> : <StatusBadge status={source.health} />}
      {source.isActive ? null : (
        <StatusBadge status="INACTIVE" label={source.permissionVerifiedAt ? ADMIN_PAUSED_LABEL : SCHEDULE_OFF_LABEL} tone="neutral" />
      )}
    </>
  );
}
