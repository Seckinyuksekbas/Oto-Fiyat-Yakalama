'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell,
  CreditCard,
  Gauge,
  Heart,
  LayoutDashboard,
  Menu,
  Radar,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';
import { VerifyBanner } from './verify-banner';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Yalnızca tam eşleşmede etkin (Dashboard). */
  exact?: boolean;
}

export const NAV_GROUPS: NavItem[][] = [
  [
    { href: '/app', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    { href: '/app/firsatlar', label: 'Fırsatlar', icon: Gauge },
  ],
  [
    { href: '/app/profiller', label: 'Arama Profillerim', icon: SlidersHorizontal },
    { href: '/app/eslesmeler', label: 'Eşleşmeler', icon: Radar },
    { href: '/app/favoriler', label: 'Favoriler', icon: Heart },
    { href: '/app/bildirimler', label: 'Bildirimler', icon: Bell },
  ],
  [
    { href: '/app/abonelik', label: 'Abonelik', icon: CreditCard },
    { href: '/app/ayarlar', label: 'Ayarlar', icon: Settings },
  ],
];

const ALL_ITEMS = NAV_GROUPS.flat();

export function isActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function pageTitle(pathname: string): string {
  if (pathname.startsWith('/app/ilan/')) return 'İlan detayı';
  return ALL_ITEMS.find((i) => isActive(i, pathname))?.label ?? 'Panel';
}

/** Task 8 zili buraya yerleştirir: `<AppShell bellSlot={<NotificationBell />}>`. */
export function NotificationBellSlot() {
  return null;
}

export function Brand({ href = '/app', badge }: { href?: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={href}
        className="flex items-center gap-2.5 rounded-md px-1 py-1 font-display text-[17px] font-semibold tracking-tight"
      >
        <span aria-hidden className="grid size-7 place-items-center rounded-[9px] bg-accent text-accent-fg">
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 16a8 8 0 1 1 16 0" />
            <path d="m12 16 4-5" />
          </svg>
        </span>
        Oto Fırsat
      </Link>
      {badge}
    </div>
  );
}

export function NavList({
  groups,
  pathname,
  label = 'Ana menü',
  onNavigate,
}: {
  groups: NavItem[][];
  pathname: string;
  label?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={label} className="flex flex-col gap-4">
      {groups.map((group, gi) => (
        <ul key={gi} className={cn('flex flex-col gap-0.5', gi > 0 && 'border-t border-border pt-4')}>
          {group.map((item) => {
            const active = isActive(item, pathname);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  onClick={onNavigate}
                  className={cn(
                    'relative flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors',
                    active
                      ? 'bg-surface-2 font-medium text-text before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-accent'
                      : 'text-muted hover:bg-surface-2/70 hover:text-text',
                  )}
                >
                  <Icon aria-hidden className={cn('size-[18px]', active && 'text-accent')} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}

export interface ShellFrameProps {
  children: ReactNode;
  groups: NavItem[][];
  navLabel?: string;
  /** Başlık çubuğundaki sayfa adı (`<p>`; sayfanın h1'i içerikte). */
  title: string;
  brand: ReactNode;
  /** Başlık çubuğunun sağındaki denetimler (zil, tema, kullanıcı menüsü …). */
  actions: ReactNode;
  /** Kenar çubuğunun altı (ör. yönetimden panele dönüş). */
  sidebarFooter?: ReactNode;
  /** Başlık çubuğunun altında, içerikten önce (ör. doğrulama bandı). */
  banner?: ReactNode;
}

/** Panel ve yönetim kabuklarının ortak iskeleti: kenar çubuğu, mobil çekmece, yapışkan başlık, "İçeriğe geç". */
export function ShellFrame({ children, groups, navLabel, title, brand, actions, sidebarFooter, banner }: ShellFrameProps) {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);

  // Görünüm masaüstü genişliğine geçince açık çekmece kapanır.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[248px_1fr]">
      <a
        href="#icerik"
        className="sr-only z-50 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        İçeriğe geç
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r border-border bg-surface px-3 py-5 md:flex">
        <div className="px-1">{brand}</div>
        <NavList groups={groups} pathname={pathname} label={navLabel} />
        {sidebarFooter ? <div className="mt-auto">{sidebarFooter}</div> : null}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-4 backdrop-blur md:px-8">
          <Sheet open={open} onOpenChange={setOpen}>
            <button
              type="button"
              aria-label="Menüyü aç"
              onClick={() => setOpen(true)}
              className="-ml-2 grid size-10 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text md:hidden"
            >
              <Menu aria-hidden className="size-5" />
            </button>
            <SheetContent side="left" className="gap-6 px-3 py-5">
              <SheetTitle className="sr-only">Menü</SheetTitle>
              <SheetDescription className="sr-only">Sayfalar arasında gezinin.</SheetDescription>
              <div className="px-1">{brand}</div>
              <NavList groups={groups} pathname={pathname} label={navLabel} onNavigate={() => setOpen(false)} />
              {sidebarFooter ? <div className="mt-auto">{sidebarFooter}</div> : null}
            </SheetContent>
          </Sheet>

          <p className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold tracking-tight">{title}</p>

          <div className="flex items-center gap-1">{actions}</div>
        </header>

        {banner}
        <main id="icerik" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 outline-none md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppShell({ children, bellSlot }: { children: ReactNode; bellSlot?: ReactNode }) {
  const pathname = usePathname() ?? '/app';
  return (
    <ShellFrame
      groups={NAV_GROUPS}
      title={pageTitle(pathname)}
      brand={<Brand />}
      actions={
        <>
          {bellSlot ?? <NotificationBellSlot />}
          <ThemeToggle />
          <UserMenu />
        </>
      }
      banner={<VerifyBanner />}
    >
      {children}
    </ShellFrame>
  );
}
