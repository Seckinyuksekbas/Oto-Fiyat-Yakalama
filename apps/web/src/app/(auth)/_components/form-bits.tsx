'use client';
import * as React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

export function Heading({ title, lead }: { title: string; lead?: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="text-[1.75rem] font-semibold leading-tight">{title}</h1>
      {lead ? <p className="mt-2 max-w-[40ch] text-sm text-[var(--color-muted)]">{lead}</p> : null}
    </div>
  );
}

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  ({ label, error, hint, className, ...props }, ref) => {
    const id = React.useId();
    const descId = `${id}-desc`;
    return (
      <div className={cn('space-y-1.5', className)}>
        <Label htmlFor={id}>{label}</Label>
        <Input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? descId : undefined}
          {...props}
        />
        {error ? (
          <p id={descId} className="text-[13px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : hint ? (
          <p id={descId} className="text-[13px] text-[var(--color-muted)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = 'Field';

export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklab,var(--color-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] px-3 py-2.5 text-sm text-[var(--color-text)]"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function FormNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklab,var(--color-positive)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-positive)_10%,transparent)] px-3 py-2.5 text-sm text-[var(--color-text)]"
    >
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-positive)]" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export const authLinkClass =
  'text-[var(--color-text)] underline decoration-[var(--color-border)] underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]';
