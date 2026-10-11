'use client';
import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/cn';

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] transition-colors data-[state=checked]:border-transparent data-[state=checked]:bg-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-[18px] translate-x-[3px] rounded-full bg-[var(--color-text)] transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-[var(--color-accent-fg)]" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
