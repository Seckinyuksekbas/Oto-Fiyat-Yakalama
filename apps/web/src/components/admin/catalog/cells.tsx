import type { AnalysisSummary } from '@oto/shared';
import { StatusBadge, type StatusTone } from '@/components/admin/status-badge';
import { formatDateTime, formatRelative } from '@/lib/format';

/** Task 11 tabloları için küçük, paylaşılan hücreler. */

const CONF_SHORT: Record<string, { label: string; tone: StatusTone }> = {
  HIGH: { label: 'Yüksek güven', tone: 'positive' },
  MEDIUM: { label: 'Orta güven', tone: 'neutral' },
  LOW: { label: 'Düşük güven', tone: 'warning' },
  INSUFFICIENT: { label: 'Yetersiz veri', tone: 'neutral' },
};

export const CONFIDENCE_OPTIONS = [
  { value: 'HIGH', label: 'Yüksek' },
  { value: 'MEDIUM', label: 'Orta' },
  { value: 'LOW', label: 'Düşük' },
  { value: 'INSUFFICIENT', label: 'Yetersiz veri' },
];

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const d = CONF_SHORT[confidence];
  return <StatusBadge status={confidence} label={d?.label} tone={d?.tone} />;
}

/** Fırsat skoru: 60 ve üzeri amber (Plan 06 fırsat eşiği), altı metin rengi. Skor sayıdır → Geist Mono. */
export function ScoreValue({ score }: { score: number }) {
  const v = Math.round(score);
  return (
    <span className={v >= 60 ? 'num font-medium text-accent' : 'num text-text'} aria-label={`Fırsat skoru ${v}`}>
      {v}
    </span>
  );
}

export function AnalysisCell({ a }: { a: AnalysisSummary | null }) {
  if (!a) return <span className="text-muted">Analiz yok</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <ScoreValue score={a.opportunityScore} />
      <ConfidenceBadge confidence={a.confidence} />
    </span>
  );
}

export function ListingStatusBadge({ status }: { status: string }) {
  return status === 'REMOVED' ? <StatusBadge status="REMOVED" label="Yayından kalktı" tone="neutral" /> : <StatusBadge status={status} />;
}

const DAY = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Yalnızca tarih (İstanbul): "11.10.2026". */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? DAY.format(d) : '—';
}

export function When({ iso, empty = 'hiç' }: { iso: string | null | undefined; empty?: string }) {
  if (!iso) return <span className="text-muted">{empty}</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

export const TRIGGER_LABEL: Record<string, string> = { SCHEDULED: 'Zamanlanmış', MANUAL: 'Elle' };

export const PERMISSION_LABEL: Record<string, string> = {
  LICENSED_API: 'Lisanslı API',
  PARTNER_FEED: 'Partner akışı',
  TOS_PERMITTED: 'Kullanım koşullarıyla izinli',
  TEST: 'Test kaynağı',
};

export const ERROR_KIND_LABEL: Record<string, string> = {
  NETWORK: 'Ağ',
  TIMEOUT: 'Zaman aşımı',
  HTTP_4XX: 'HTTP 4xx',
  HTTP_5XX: 'HTTP 5xx',
  BLOCKED: 'Engellendi',
  PARSE: 'Ayrıştırma',
  VALIDATION: 'Doğrulama',
};
