'use client';
import { Suspense, type ReactNode } from 'react';
import { EmptyState } from '@/components/empty-state';
import { NotFoundView } from '@/components/not-found-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useAdminRole } from '@/lib/admin-queries';
import { useAdminStream } from '@/lib/admin-stream';
import { useMe } from '@/lib/queries';
import { RetryFlagStripper } from '@/lib/session';
import { AdminShell } from './admin-shell';

/** Rol bilinene kadar nötr iskelet: yönetim paneline ait hiçbir metin göstermez. */
function NeutralSkeleton() {
  return (
    <div aria-busy="true" className="min-h-dvh md:grid md:grid-cols-[248px_1fr]">
      <div className="hidden border-r border-border bg-surface md:block" />
      <div className="flex flex-col gap-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[92px] w-full rounded-lg" />
        <Skeleton className="h-[220px] w-full rounded-lg" />
      </div>
    </div>
  );
}

function MeError({ onRetry }: { onRetry(): void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-6">
      <EmptyState
        title="Sayfa yüklenemedi"
        description="Bağlantınızı kontrol edip yeniden deneyin."
        action={
          <Button variant="secondary" onClick={onRetry}>
            Yeniden dene
          </Button>
        }
      />
    </main>
  );
}

/** Yalnızca rol doğrulandıktan sonra bağlanır: canlı akış + kabuk. */
function AdminWorkspace({ children }: { children: ReactNode }) {
  useAdminStream();
  return (
    <AdminShell>
      <Suspense fallback={null}>
        <RetryFlagStripper />
      </Suspense>
      {children}
    </AdminShell>
  );
}

/**
 * `/admin` düzeninin istemci kapısı. Middleware yalnızca çerez varlığına bakar; rol burada `/me`'den okunur.
 * ADMIN/SUPER_ADMIN değilse gerçek 404 ile aynı görünüm verilir (403 değil: `/admin` varlığı sızmasın) ve ne kabuk ne
 * akış açılır. Asıl yetki API'dedir: her `/admin` ucu USER'a 403 döner.
 */
export function AdminLayoutClient({ children }: { children: ReactNode }) {
  const me = useMe();
  const { isPending, isAdmin } = useAdminRole();
  if (isPending) return <NeutralSkeleton />;
  if (me.isError) {
    // 401: apiFetch oturum yenilemeyi dener, olmazsa girişe yönlendirir; bu arada nötr iskelet kalır.
    if (me.error instanceof ApiError && me.error.status === 401) return <NeutralSkeleton />;
    return <MeError onRetry={() => void me.refetch()} />;
  }
  if (!isAdmin) return <NotFoundView resetTitle />;
  return <AdminWorkspace>{children}</AdminWorkspace>;
}

/**
 * SUPER_ADMIN'e özel sayfa gövdesi (Paketler, Ayarlar, Denetim). ADMIN'e kabuk içinde 404 görünümü verir.
 * Task 12: `export default function Page() { return <RequireSuperAdmin><PlansView /></RequireSuperAdmin>; }`
 */
export function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { isPending, isSuperAdmin } = useAdminRole();
  if (isPending) return <Skeleton aria-busy="true" className="h-[220px] w-full rounded-lg" />;
  if (!isSuperAdmin) return <NotFoundView inline />;
  return <>{children}</>;
}
