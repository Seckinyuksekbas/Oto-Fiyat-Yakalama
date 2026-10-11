'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Heart } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { apiErrorMessage } from '@/lib/messages';
import { cn } from '@/lib/cn';

/**
 * Favori durumunu gösteren sorguların kök anahtarları (queryKey[0]).
 * Sorgular bu köklerle başlayan anahtarlar kullanmalıdır: ['favorites'], ['opportunities'], ['listing', id], ['dashboard'].
 */
export const FAVORITE_CACHE_ROOTS = ['favorites', 'opportunities', 'listing', 'dashboard'] as const;

function isFavoriteQuery(key: readonly unknown[]): boolean {
  return (FAVORITE_CACHE_ROOTS as readonly unknown[]).includes(key[0]);
}

/** Önbellekteki `{ id, isFavorite }` nesnelerini (kart, detay, favori satırı) yerinde değiştirir; değişmeyen dallar korunur. */
function patchFavorite(data: unknown, id: number, fav: boolean): unknown {
  if (Array.isArray(data)) {
    let changed = false;
    const out = data.map((x) => {
      const y = patchFavorite(x, id, fav);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : data;
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      const y = patchFavorite(o[k], id, fav);
      out[k] = y;
      if (y !== o[k]) changed = true;
    }
    if (o.id === id && typeof o.isFavorite === 'boolean' && o.isFavorite !== fav) {
      out.isFavorite = fav;
      changed = true;
    }
    return changed ? out : data;
  }
  return data;
}

function patchCaches(qc: QueryClient, id: number, fav: boolean) {
  const snapshot = qc.getQueriesData({ predicate: (q) => isFavoriteQuery(q.queryKey) });
  for (const [key, data] of snapshot) qc.setQueryData(key, patchFavorite(data, id, fav));
  return snapshot;
}

export interface FavoriteButtonProps {
  listingId: number;
  isFavorite: boolean;
  /** Erişilebilir ad için ilan başlığı: "BMW 320i favori". */
  title?: string;
  onChange?: (next: boolean) => void;
  className?: string;
}

/**
 * İyimser favori geçişi: arayüz ve TanStack önbelleği hemen güncellenir; istek başarısız olursa
 * ikisi de geri alınır ve uyarı gösterilir. Başarıda ilgili sorgular yenilenir.
 */
export function FavoriteButton({ listingId, isFavorite, title, onChange, className }: FavoriteButtonProps) {
  const qc = useQueryClient();
  const [fav, setFav] = useState(isFavorite);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Üst bileşenden gelen değeri yalnızca istek uçuşta değilken eşitle (geri sıçramayı önler).
  useEffect(() => {
    if (!pendingRef.current) setFav(isFavorite);
  }, [isFavorite]);

  async function toggle() {
    if (pendingRef.current) return;
    const prev = fav;
    const next = !prev;
    pendingRef.current = true;
    setPending(true);
    setFav(next);
    const snapshot = patchCaches(qc, listingId, next);
    onChange?.(next);
    try {
      await apiFetch<void>(`/me/favorites/${listingId}`, next ? { method: 'PUT', json: {} } : { method: 'DELETE' });
      // Fırsat listeleri yama ile zaten güncel; yeniden çekmek sıralamayı/kaydırmayı bozar. Diğerleri tazelenir.
      await Promise.all(
        FAVORITE_CACHE_ROOTS.map((root) =>
          qc.invalidateQueries({ queryKey: [root], ...(root === 'opportunities' ? { refetchType: 'none' as const } : {}) }),
        ),
      );
    } catch (err) {
      for (const [key, data] of snapshot) qc.setQueryData(key, data);
      if (mounted.current) setFav(prev);
      onChange?.(prev);
      toast.error(apiErrorMessage(err));
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <button
      type="button"
      aria-pressed={fav}
      aria-busy={pending || undefined}
      onClick={toggle}
      className={cn(
        'inline-grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text',
        fav && 'text-accent hover:text-accent',
        className,
      )}
    >
      <span className="sr-only">{title ? `${title} favori` : 'Favori'}</span>
      <Heart aria-hidden className="size-[18px]" fill={fav ? 'currentColor' : 'none'} />
    </button>
  );
}
