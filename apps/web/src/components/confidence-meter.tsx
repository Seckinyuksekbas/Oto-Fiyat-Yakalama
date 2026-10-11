import type { AnalysisSummary } from '@oto/shared';
import { cn } from '@/lib/cn';
import { CONFIDENCE_LABEL } from '@/lib/format';

type Confidence = AnalysisSummary['confidence'];

const FILLED: Record<Confidence, number> = { HIGH: 4, MEDIUM: 3, LOW: 2, INSUFFICIENT: 1 };
const TONE: Record<Confidence, string> = {
  HIGH: 'text-positive-text',
  MEDIUM: 'text-warning-text',
  LOW: 'text-danger-text',
  INSUFFICIENT: 'text-muted',
};

export interface ConfidenceMeterProps {
  confidence: Confidence;
  comparableCount: number;
  /** Kartta yalnızca kısa etiket ("Yüksek"); emsal sayısı alt satırda gösterilir. */
  compact?: boolean;
  className?: string;
}

/** Sinyal çubuğu biçiminde 4 segment; renge ek olarak metin etiketi her zaman görünür. */
export function ConfidenceMeter({ confidence, comparableCount, compact, className }: ConfidenceMeterProps) {
  const filled = FILLED[confidence];
  const full = CONFIDENCE_LABEL[confidence];
  const text = compact ? full.replace(' güven', '') : `${full} · ${comparableCount} emsal`;
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs', className)} title={compact ? `${full} · ${comparableCount} emsal` : undefined}>
      <span aria-hidden className={cn('inline-flex items-end gap-[2px]', TONE[confidence])}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            data-filled={i < filled ? 'true' : 'false'}
            className="w-[4px] rounded-[1px] bg-current data-[filled=false]:bg-border-strong data-[filled=false]:opacity-40"
            style={{ height: 6 + i * 3 }}
          />
        ))}
      </span>
      <span className={cn('font-medium', TONE[confidence])}>{text}</span>
    </span>
  );
}
