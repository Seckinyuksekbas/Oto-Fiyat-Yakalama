import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export type StatusTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';

interface StatusDef {
  label: string;
  tone: StatusTone;
}

/**
 * Admin durum sözlüğü. Aynı enum değeri farklı alanlarda aynı anlamı taşıdığı için tek tablo yeterlidir
 * (ör. `FAILED` hem iş hem bildirim). Task 11–12 yeni değerleri buraya ekler.
 */
export const STATUS_DEFS: Record<string, StatusDef> = {
  // kullanıcı
  ACTIVE: { label: 'Aktif', tone: 'positive' },
  SUSPENDED: { label: 'Askıda', tone: 'warning' },
  DELETED: { label: 'Silindi', tone: 'neutral' },
  // rol
  USER: { label: 'Kullanıcı', tone: 'neutral' },
  ADMIN: { label: 'Admin', tone: 'accent' },
  SUPER_ADMIN: { label: 'Süper admin', tone: 'accent' },
  // kaynak sağlığı
  HEALTHY: { label: 'Sağlıklı', tone: 'positive' },
  DEGRADED: { label: 'Aksıyor', tone: 'warning' },
  DOWN: { label: 'Çalışmıyor', tone: 'danger' },
  PAUSED: { label: 'Duraklatıldı', tone: 'neutral' },
  // iş
  QUEUED: { label: 'Sırada', tone: 'neutral' },
  RUNNING: { label: 'Çalışıyor', tone: 'accent' },
  SUCCEEDED: { label: 'Başarılı', tone: 'positive' },
  FAILED: { label: 'Başarısız', tone: 'danger' },
  PARTIAL: { label: 'Kısmi', tone: 'warning' },
  // bildirim
  PENDING: { label: 'Bekliyor', tone: 'neutral' },
  SENT: { label: 'Gönderildi', tone: 'positive' },
  SKIPPED_LIMIT: { label: 'Limit', tone: 'warning' },
  // abonelik
  EXPIRED: { label: 'Süresi doldu', tone: 'neutral' },
  CANCELED: { label: 'İptal', tone: 'neutral' },
  // log seviyesi
  WARN: { label: 'Uyarı', tone: 'warning' },
  ERROR: { label: 'Hata', tone: 'danger' },
  // worker
  ALIVE: { label: 'Canlı', tone: 'positive' },
  DEAD: { label: 'Yanıt vermiyor', tone: 'danger' },
};

const DOT: Record<StatusTone, string> = {
  neutral: 'bg-muted',
  accent: 'bg-accent',
  positive: 'bg-positive',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface StatusBadgeProps {
  status: string;
  /** Sözlük etiketini geçersiz kılar. */
  label?: string;
  /** Sözlük tonunu geçersiz kılar. */
  tone?: StatusTone;
  className?: string;
}

/** Renk tek başına anlam taşımaz: nokta + metin etiketi. Bilinmeyen değer ham haliyle, nötr tonda gösterilir. */
export function StatusBadge({ status, label, tone, className }: StatusBadgeProps) {
  const def = STATUS_DEFS[status];
  const t = tone ?? def?.tone ?? 'neutral';
  return (
    <Badge tone={t} className={cn('whitespace-nowrap', className)}>
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[t])} />
      {label ?? def?.label ?? status}
    </Badge>
  );
}
