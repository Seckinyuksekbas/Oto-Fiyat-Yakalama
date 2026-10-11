import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-5',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]',
        accent:
          'border-[color-mix(in_oklab,var(--color-accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]',
        positive:
          'border-[color-mix(in_oklab,var(--color-positive)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-positive)_14%,transparent)] text-[var(--color-positive)]',
        warning:
          'border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_14%,transparent)] text-[var(--color-warning)]',
        danger:
          'border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_14%,transparent)] text-[var(--color-danger)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
