import * as React from 'react';
import { cn } from '@/lib/cn';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)] transition-colors hover:border-[color-mix(in_oklab,var(--color-border)_60%,var(--color-muted))] disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-[var(--color-danger)]',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
