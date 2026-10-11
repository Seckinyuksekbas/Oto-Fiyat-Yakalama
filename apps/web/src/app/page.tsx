import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';

/** Statik fiyat bandı ön izlemesi. Gerçek bileşen (price-band) Task 6'da gelir. */
function BandPreview() {
  // Eksen 780.000 – 1.140.000 ₺; yüzdeler bu aralığa göre.
  const q1 = 28;
  const median = 52;
  const q3 = 78;
  const price = 25; // (869 - 780) / (1140 - 780) ≈ %25
  return (
    <figure
      className="w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 sm:p-8"
      aria-label="Örnek ilan için fiyat bandı ön izlemesi"
    >
      <figcaption className="flex items-start justify-between gap-6">
        <div>
          <p className="text-xs font-medium text-[var(--color-muted)]">Örnek ilan, gösterim amaçlıdır</p>
          <p className="mt-2 text-sm text-[var(--color-muted)]">2019 · 62.400 km · Dizel</p>
          <p className="mt-1 font-[family-name:var(--font-display)] text-xl font-semibold">
            Volkswagen Passat 1.6 TDI
          </p>
        </div>
        <div className="text-right">
          <p className="num text-3xl font-semibold leading-none text-[var(--color-accent)]">86</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">fırsat skoru</p>
        </div>
      </figcaption>

      <svg viewBox="0 0 400 104" className="mt-8 w-full" role="img" aria-label="İlan fiyatı piyasa bandının altında">
        <rect x="0" y="40" width="400" height="16" rx="8" fill="var(--color-surface-2)" />
        <rect
          x={q1 * 4}
          y="40"
          width={(q3 - q1) * 4}
          height="16"
          rx="8"
          fill="color-mix(in oklab, var(--color-positive) 30%, var(--color-surface-2))"
          stroke="var(--color-border)"
        />
        <line x1={median * 4} x2={median * 4} y1="34" y2="62" stroke="var(--color-text)" strokeWidth="2" />
        <line x1={price * 4} x2={price * 4} y1="22" y2="74" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" />
        <circle cx={price * 4} cy="48" r="7" fill="var(--color-accent)" />
        <text x={price * 4} y="14" textAnchor="middle" fontSize="16" fill="var(--color-accent)" className="num">
          869.000 ₺
        </text>
        <text x={median * 4} y="98" textAnchor="middle" fontSize="15" fill="var(--color-muted)" className="num">
          medyan 972.000 ₺
        </text>
      </svg>

      <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-[var(--color-border)] pt-5 text-sm">
        <div>
          <dt className="text-[var(--color-muted)]">Piyasa altı</dt>
          <dd className="num mt-0.5 text-[var(--color-positive)]">%10,6</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">Emsal</dt>
          <dd className="tnum mt-0.5">34 ilan</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">Güven</dt>
          <dd className="mt-0.5">Yüksek</dd>
        </div>
      </dl>
    </figure>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight">
          Oto Fırsat
        </Link>
        <nav aria-label="Ana gezinme" className="flex items-center gap-1">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link href="/giris">Giriş yap</Link>
          </Button>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-20">
          <div>
            <h1 className="max-w-[16ch] text-4xl font-semibold leading-[1.05] sm:text-6xl">
              Piyasanın altındaki ilanları ilk siz görün
            </h1>
            <p className="mt-6 max-w-[46ch] text-lg text-[var(--color-muted)]">
              Her ilan emsallerine göre fiyatlanır. Aradığınız araç piyasa bandının altına girdiğinde,
              nedenini görerek haberdar olursunuz.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/kayit">Ücretsiz başla</Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link href="/giris">Giriş yap</Link>
              </Button>
            </div>
          </div>
          <BandPreview />
        </section>

        <section className="border-t border-[var(--color-border)]">
          <div className="mx-auto grid max-w-6xl gap-px bg-[var(--color-border)] px-0 sm:grid-cols-3">
            {[
              ['Emsale göre fiyat', 'Aynı marka, model, yıl ve kilometre aralığındaki ilanlarla karşılaştırılır.'],
              ['Nedeni görünür', 'Skor kadar emsal sayısı ve güven düzeyi de gösterilir; tahmin zayıfsa söylenir.'],
              ['Sizin kriterleriniz', 'Arama profili oluşturun; eşleşmeler uygulama içinde ve Telegram’da size ulaşır.'],
            ].map(([title, body]) => (
              <div key={title} className="bg-[var(--color-bg)] px-6 py-8">
                <h2 className="text-lg font-semibold">{title}</h2>
                <p className="mt-2 max-w-[38ch] text-sm text-[var(--color-muted)]">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--color-border)]">
        <p className="mx-auto max-w-6xl px-6 py-6 text-xs text-[var(--color-muted)]">
          Fiyat analizi tahminidir; aracın durumunu garanti etmez.
        </p>
      </footer>
    </div>
  );
}
