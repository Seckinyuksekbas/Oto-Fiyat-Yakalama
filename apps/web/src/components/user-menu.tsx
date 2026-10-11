'use client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronDown, LayoutDashboard, LogOut, Settings, ShieldCheck } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { isAdminRole } from '@/lib/admin-api';
import { purgeUserCache, useLogout, useMe } from '@/lib/queries';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const picked = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : [parts[0] ?? '?'];
  return picked.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('');
}

/** `context="admin"`: yönetim kabuğunda kullanıcı paneline dönüş bağlantısı gösterilir. */
export function UserMenu({ context = 'app' }: { context?: 'app' | 'admin' }) {
  const me = useMe();
  const logout = useLogout();
  const router = useRouter();
  const user = me.data?.user;

  const qc = useQueryClient();
  const signOut = () => {
    // Önce eşzamanlı temizlik: giriş sayfası bayat /me önbelleğini görüp /app'e geri atmasın.
    purgeUserCache(qc);
    router.replace('/giris');
    logout.mutate();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Hesap menüsü${user ? `: ${user.name}` : ''}`}
        className="flex h-9 items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2"
      >
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-full bg-surface-2 font-display text-xs font-semibold ring-1 ring-border-strong/50"
        >
          {user ? initials(user.name) : ''}
        </span>
        <span className="hidden max-w-[140px] truncate sm:block">{user?.name ?? ''}</span>
        <ChevronDown aria-hidden className="size-4 text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px]">
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2.5 py-2">
          <span className="truncate text-sm font-semibold">{user?.name}</span>
          <span className="truncate text-[13px] font-normal text-muted">{user?.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {context === 'admin' ? (
          <DropdownMenuItem asChild>
            <Link href="/app">
              <LayoutDashboard aria-hidden className="size-4" />
              Kullanıcı paneli
            </Link>
          </DropdownMenuItem>
        ) : isAdminRole(user?.role) ? (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <ShieldCheck aria-hidden className="size-4" />
              Yönetim paneli
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href="/app/ayarlar">
            <Settings aria-hidden className="size-4" />
            Ayarlar
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={signOut}>
          <LogOut aria-hidden className="size-4" />
          Çıkış
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
