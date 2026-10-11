import { cn } from '@/lib/cn';

export interface ScoreRingProps {
  score: number;
  size?: number;
  className?: string;
}

/** 60 ve üzeri fırsat eşiğidir; halka amber, altı sessiz gri. Eşik 60'ta ince bir çentikle gösterilir. */
export function ScoreRing({ score, size = 52, className }: ScoreRingProps) {
  const valid = Number.isFinite(score);
  const value = valid ? Math.min(100, Math.max(0, Math.round(score))) : 0;
  const stroke = Math.max(3, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const hot = valid && value >= 60;
  const cx = size / 2;
  // 60. nokta: -90° başlangıçtan saat yönünde 0,6 tur
  const a = (0.6 * 360 - 90) * (Math.PI / 180);
  const tick = (rad: number) => [cx + rad * Math.cos(a), cx + rad * Math.sin(a)] as const;
  const [x1, y1] = tick(r - stroke / 2 - 1);
  const [x2, y2] = tick(r + stroke / 2 + 1);

  return (
    <div
      role="img"
      aria-label={valid ? `Fırsat skoru ${value}/100` : 'Fırsat skoru yok'}
      className={cn('relative inline-grid shrink-0 place-items-center', hot ? 'text-accent' : 'text-muted', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="absolute inset-0">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
        <circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(c * value) / 100} ${c}`}
          transform={`rotate(-90 ${cx} ${cx})`}
          style={hot ? { filter: 'drop-shadow(0 0 4px color-mix(in oklab, var(--color-accent) 55%, transparent))' } : undefined}
        />
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-border-strong)" strokeWidth={1.5} />
      </svg>
      <span
        aria-hidden
        className={cn('num font-semibold leading-none', hot ? 'text-text' : 'text-muted')}
        style={{ fontSize: Math.round(size * 0.34) }}
      >
        {valid ? value : '—'}
      </span>
    </div>
  );
}
