import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Boş ekran bir yönlendirmedir: ne olduğunu söyler, sıradaki adımı önerir. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-strong/60 bg-surface/60 p-6 sm:p-8',
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="grid size-10 place-items-center rounded-md bg-surface-2 text-muted">
          {icon}
        </span>
      ) : null}
      <h2 className="font-display text-lg font-semibold leading-snug">{title}</h2>
      {description ? <p className="max-w-[56ch] text-sm leading-relaxed text-muted">{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
