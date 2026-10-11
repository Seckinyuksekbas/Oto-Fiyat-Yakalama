'use client';
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api';
import { stripRetryFlagFromLocation } from '@/lib/session';

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

/** `<html data-theme>` değerini izler; kullanıcı temayı değiştirince toast teması da değişir. */
function useDocumentTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeQueryClient);
  const theme = useDocumentTheme();
  useEffect(() => {
    stripRetryFlagFromLocation();
  }, []);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={200}>
        {children}
        <Toaster
          theme={theme}
          position="bottom-right"
          visibleToasts={3}
          expand
          gap={10}
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
