'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LayoutGrid, Rows3, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { FiltersBar } from '@/components/filters-bar';
import { ListingCardView } from '@/components/listing-card';
import { ListingTable } from '@/components/listing-table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/messages';
import {
  LEGAL_NOTE,
  NEXT_PAGE_ERROR,
  parseOpportunityParams,
  useOpportunities,
  type OpportunityFilters,
} from '@/lib/panel-queries';

const VIEW_KEY = 'opportunities-view';
type View = 'card' | 'table';

function useStoredView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>('card');
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'card' || v === 'table') setView(v);
    } catch {
      /* depolama kapalı */
    }
  }, []);
  const set = useCallback((v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* depolama kapalı */
    }
  }, []);
  return [view, set];
}

function SkeletonGrid() {
  return (
    <div aria-busy="true" aria-label="İlanlar yükleniyor" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-[236px] rounded-lg" />
      ))}
    </div>
  );
}

function OpportunitiesInner() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const spString = sp.toString();
  const parsed = useMemo(() => parseOpportunityParams(new URLSearchParams(spString)), [spString]);
  const filters = parsed.filters;
  // Geçersiz URL parametreleri temizlenmiş adrese yönlendirilir.
  useEffect(() => {
    if (parsed.clean !== spString) router.replace(parsed.clean ? `${pathname}?${parsed.clean}` : pathname, { scroll: false });
  }, [parsed.clean, spString, router, pathname]);
  const [view, setView] = useStoredView();

  const setFilters = useCallback(
    (patch: OpportunityFilters) => {
      const next = new URLSearchParams(parsed.clean);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [parsed.clean, router, pathname],
  );
  const reset = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);

  const q = useOpportunities(filters);
  const rows = useMemo(() => {
    const seen = new Set<number>();
    const out = [];
    for (const p of q.data?.pages ?? []) {
      for (const c of p.items) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    return out;
  }, [q.data]);

  // Sonsuz kaydırma: sentinel görünür olunca sonraki sayfa.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, rows.length]);

  const filtered = Object.keys(filters).some((k) => !(k === 'sort' && filters.sort === 'score'));

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Fırsatlar</h1>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">
            Piyasa fiyatının belirgin altında kalan, yeterli emsali olan ilanlar. Skor 60 ve üstü, güven en az orta.
          </p>
        </div>
        <div role="group" aria-label="Görünüm" className="flex overflow-hidden rounded-md border border-border-strong">
          {(
            [
              ['card', 'Kart görünümü', LayoutGrid],
              ['table', 'Tablo görünümü', Rows3],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              aria-label={label}
              onClick={() => setView(v)}
              className={
                'grid size-10 place-items-center transition-colors ' +
                (view === v ? 'bg-surface-2 text-accent' : 'bg-surface text-muted hover:text-text')
              }
            >
              <Icon aria-hidden className="size-[18px]" />
            </button>
          ))}
        </div>
      </header>

      <FiltersBar value={filters} onChange={setFilters} onReset={reset} />

      {q.isPending ? (
        <SkeletonGrid />
      ) : q.isError && !q.data ? (
        <EmptyState
          title="Fırsatlar yüklenemedi"
          description={apiErrorMessage(q.error)}
          action={<Button onClick={() => void q.refetch()}>Yeniden dene</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<SearchX className="size-5" />}
          title={filtered ? 'Bu filtrelerle fırsat bulunamadı' : 'Şu an listelenecek fırsat yok'}
          description={
            filtered
              ? 'Filtreleri gevşetmeyi deneyin: en düşük skoru ya da fiyat sınırını değiştirin.'
              : 'Yeni ilanlar analiz edildikçe burada görünür. Arama profili oluşturursanız eşleşmeler size bildirilir.'
          }
          action={filtered ? <Button variant="secondary" onClick={reset}>Filtreleri sıfırla</Button> : undefined}
        />
      ) : (
        <>
          <p className="num text-xs text-muted" aria-live="polite">
            {q.isPlaceholderData ? 'Güncelleniyor…' : `${rows.length} ilan${hasNextPage ? ' · devamı var' : ''}`}
          </p>
          <div aria-busy={q.isPlaceholderData || undefined} className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            {view === 'table' ? (
              <ListingTable rows={rows} />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((c) => (
                  <li key={c.id}>
                    <ListingCardView card={c} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div ref={sentinel} className="flex justify-center py-4">
            {isFetchNextPageError ? (
              <div role="alert" className="flex flex-col items-center gap-2 text-sm">
                <p className="text-danger-text">{NEXT_PAGE_ERROR}</p>
                <Button variant="secondary" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                  Tekrar dene
                </Button>
              </div>
            ) : hasNextPage ? (
              <Button variant="secondary" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Yükleniyor…' : 'Daha fazla yükle'}
              </Button>
            ) : (
              <p className="text-sm text-muted">Hepsi bu kadar.</p>
            )}
          </div>
        </>
      )}

      <p className="max-w-[80ch] text-xs leading-relaxed text-muted">{LEGAL_NOTE}</p>
    </div>
  );
}

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<SkeletonGrid />}>
      <OpportunitiesInner />
    </Suspense>
  );
}
