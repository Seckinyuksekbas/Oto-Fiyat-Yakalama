'use client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={200}>
        {children}
        <Toaster
          theme="system"
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--color-surface-2)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
