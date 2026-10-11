import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-5 px-6">
      <p className="num text-sm text-[var(--color-muted)]">404</p>
      <h1 className="text-3xl font-semibold">Bu sayfa bulunamadı</h1>
      <p className="text-[var(--color-muted)]">
        Aradığınız ilan kaldırılmış ya da bağlantı hatalı olabilir. Fırsatlar sayfasından devam edin.
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/app/firsatlar">Fırsatlara git</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Ana sayfa</Link>
        </Button>
      </div>
    </main>
  );
}
