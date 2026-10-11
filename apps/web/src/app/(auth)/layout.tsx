import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight">
          Oto Fırsat
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-8 sm:items-center sm:pt-0">
        <div className="relative w-full max-w-[26rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] py-8 pl-8 pr-7 sm:py-10 sm:pl-10 sm:pr-9">
          {/* Sol kenarda ince amber çizgi: giriş yapılan "gece vitrini" kartının imzası */}
          <span
            aria-hidden="true"
            className="absolute inset-y-6 left-0 w-[3px] rounded-r-full bg-[var(--color-accent)]"
          />
          {children}
        </div>
      </main>

      <footer className="px-6 pb-6 text-center text-xs text-[var(--color-muted)]">
        Oturum bilgileriniz yalnızca bu tarayıcıda, güvenli çerezlerde tutulur.
      </footer>
    </div>
  );
}
