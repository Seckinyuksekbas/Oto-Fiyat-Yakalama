'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Uygulamanın 404 görünümü. Yönetim paneli de yetkisiz rollere aynı görünümü verir (403 değil): `/admin`'in varlığı
 * belli olmasın diye metin ve düzen gerçek 404 sayfasıyla birebir aynıdır.
 *
 * `inline`: bir kabuğun içinde (ör. SUPER_ADMIN'e özel sayfa ADMIN'e) — iç içe `<main>` oluşmasın diye `<div>`.
 * `resetTitle`: istemci tarafında belge başlığını nötr "Oto Fırsat"a çeker (rota metadata'sı yönetim başlığı taşır).
 */
export function NotFoundView({ inline = false, resetTitle = false }: { inline?: boolean; resetTitle?: boolean }) {
  useEffect(() => {
    if (resetTitle) document.title = 'Oto Fırsat';
  }, [resetTitle]);
  const Tag = inline ? 'div' : 'main';
  return (
    <Tag className={cn('mx-auto flex max-w-md flex-col items-start justify-center gap-5 px-6', inline ? 'py-16' : 'min-h-dvh')}>
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
    </Tag>
  );
}
