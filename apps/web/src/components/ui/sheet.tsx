'use client';
import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 border-[var(--color-border)] bg-[var(--color-surface)] p-6',
  {
    variants: {
      side: {
        left: 'inset-y-0 left-0 h-full w-[300px] max-w-[85vw] border-r',
        right: 'inset-y-0 right-0 h-full w-[380px] max-w-[90vw] border-l',
        bottom: 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-[var(--radius-lg)] border-t',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

export const SheetContent = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Content>, SheetContentProps>(
  ({ side, className, children, ...props }, ref) => (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <SheetPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <SheetPrimitive.Close
          aria-label="Kapat"
          className="absolute right-4 top-4 rounded-[var(--radius-sm)] p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <X className="size-4" aria-hidden="true" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  ),
);
SheetContent.displayName = 'SheetContent';
