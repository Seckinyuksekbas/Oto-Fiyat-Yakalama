'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/app/ayarlar', label: 'Hesap', exact: true },
  { href: '/app/ayarlar/guvenlik', label: 'Güvenlik', exact: false },
  { href: '/app/ayarlar/kanallar', label: 'Bildirim kanalları', exact: false },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="sr-only">Ayarlar</h1>
      <nav aria-label="Ayarlar bölümleri" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => {
          const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                active ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
