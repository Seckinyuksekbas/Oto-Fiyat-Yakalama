'use client';
import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  ArrowLeft,
  Bell,
  Car,
  Database,
  FileWarning,
  Gauge,
  LayoutDashboard,
  ListChecks,
  Network,
  Package,
  ScrollText,
  Settings,
  Users,
} from 'lucide-react';
import { Brand, ShellFrame, isActive, type NavItem } from '@/components/app-shell';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserMenu } from '@/components/user-menu';
import { useAdminRole } from '@/lib/admin-queries';
import { useAdminStreamStatus } from '@/lib/admin-stream';
import { cn } from '@/lib/cn';

export interface AdminNavItem extends NavItem {
  /** Yalnızca SUPER_ADMIN'e görünür (ADMIN'de gizli; rota da `RequireSuperAdmin` ile 404 verir). */
  superOnly?: boolean;
}

/**
 * Yönetim menüsü. Henüz yazılmamış rotalar (Task 11–12) bu aşamada 404 verebilir.
 * Sıra: genel bakış → kullanıcı verisi → toplama hattı → izleme → yalnız süper admin.
 */
export const ADMIN_NAV: AdminNavItem[][] = [
  [{ href: '/admin', label: 'Genel bakış', icon: LayoutDashboard, exact: true }],
  [
    { href: '/admin/kullanicilar', label: 'Kullanıcılar', icon: Users },
    { href: '/admin/ilanlar', label: 'İlanlar', icon: Car },
    { href: '/admin/analizler', label: 'Analizler', icon: Gauge },
  ],
  [
    { href: '/admin/kaynaklar', label: 'Kaynaklar', icon: Database },
    { href: '/admin/isler', label: 'İşler', icon: ListChecks },
    { href: '/admin/proxyler', label: "Proxy'ler", icon: Network },
  ],
  [
    { href: '/admin/sistem', label: 'Sistem izleme', icon: Activity },
    { href: '/admin/bildirimler', label: 'Bildirimler', icon: Bell },
    { href: '/admin/loglar', label: 'Sistem logları', icon: FileWarning },
  ],
  [
    { href: '/admin/paketler', label: 'Paketler', icon: Package, superOnly: true },
    { href: '/admin/ayarlar', label: 'Ayarlar', icon: Settings, superOnly: true },
    { href: '/admin/denetim', label: 'Denetim', icon: ScrollText, superOnly: true },
  ],
];

export function adminNavFor(isSuperAdmin: boolean): NavItem[][] {
  return ADMIN_NAV.map((g) => g.filter((i) => isSuperAdmin || !i.superOnly)).filter((g) => g.length > 0);
}

/** Alt rotalarda başlık: `/admin/<bölüm>/<id>` → "<tekil> detayı". */
const DETAIL_TITLES: Record<string, string> = {
  '/admin/kullanicilar': 'Kullanıcı detayı',
  '/admin/ilanlar': 'İlan detayı',
  '/admin/kaynaklar': 'Kaynak detayı',
  '/admin/isler': 'İş detayı',
};

export function adminPageTitle(pathname: string): string {
  const items = ADMIN_NAV.flat();
  const item = items.find((i) => isActive(i, pathname));
  if (!item) return 'Yönetim';
  if (pathname !== item.href && DETAIL_TITLES[item.href]) return DETAIL_TITLES[item.href]!;
  return item.label;
}

export function adminDocumentTitle(pageTitle: string): string {
  return `${pageTitle} · Yönetim · Oto Fırsat`;
}

const STATUS_TEXT = { open: 'Canlı', connecting: 'Bağlanıyor', closed: 'Canlı akış kapalı' } as const;

/** Başlık çubuğunda canlı akış durumu: nokta + metin (renk tek başına anlam taşımaz). */
export function StreamIndicator() {
  const s = useAdminStreamStatus();
  return (
    <span role="status" className="mr-1 inline-flex h-8 items-center gap-2 rounded-full px-2.5 text-[13px] text-muted">
      <span aria-hidden className="relative grid size-2 place-items-center">
        {s === 'open' ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-positive opacity-60 motion-reduce:hidden" />
        ) : null}
        <span
          className={cn(
            'relative size-2 rounded-full',
            s === 'open' ? 'bg-positive' : s === 'connecting' ? 'bg-warning' : 'bg-border-strong',
          )}
        />
      </span>
      <span className="sr-only sm:not-sr-only">{STATUS_TEXT[s]}</span>
    </span>
  );
}

function AdminBrand() {
  return (
    <Brand
      href="/admin"
      badge={
        <span className="rounded-md border border-border-strong/70 px-1.5 py-0.5 text-[11.5px] font-medium leading-none text-muted">
          Yönetim
        </span>
      }
    />
  );
}

/**
 * Plan 06 kabuğunun yönetim varyantı: aynı iskelet (`ShellFrame`), "Yönetim" rozetli marka, rol süzgeçli menü,
 * başlıkta canlı akış göstergesi, kenar çubuğunda kullanıcı paneline dönüş. Rol koruması ve akış `AdminLayoutClient`'tadır;
 * bu bileşen yalnızca görüntüler.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/admin';
  const { isSuperAdmin } = useAdminRole();
  const title = adminPageTitle(pathname);
  // Sunucu metadata'sı nötr ("Oto Fırsat"); yönetim başlığı yalnızca kapı geçildikten sonra istemcide yazılır.
  useEffect(() => {
    document.title = adminDocumentTitle(title);
  }, [title]);
  return (
    <ShellFrame
      groups={adminNavFor(isSuperAdmin)}
      navLabel="Yönetim menüsü"
      title={title}
      brand={<AdminBrand />}
      actions={
        <>
          <StreamIndicator />
          <ThemeToggle />
          <UserMenu context="admin" />
        </>
      }
      sidebarFooter={
        <Link
          href="/app"
          className="flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-2/70 hover:text-text"
        >
          <ArrowLeft aria-hidden className="size-[18px]" />
          Kullanıcı paneline dön
        </Link>
      }
    >
      {children}
    </ShellFrame>
  );
}
