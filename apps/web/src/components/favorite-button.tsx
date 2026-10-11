'use client';
import { useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { apiErrorMessage } from '@/lib/messages';
import { cn } from '@/lib/cn';

export interface FavoriteButtonProps {
  listingId: number;
  isFavorite: boolean;
  onChange?: (next: boolean) => void;
  className?: string;
}

/** İyimser favori geçişi: önce arayüz değişir, istek başarısız olursa geri alınır ve uyarı gösterilir. */
export function FavoriteButton({ listingId, isFavorite, onChange, className }: FavoriteButtonProps) {
  const [fav, setFav] = useState(isFavorite);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setFav(isFavorite), [isFavorite]);

  async function toggle() {
    if (pending) return;
    const prev = fav;
    const next = !prev;
    setFav(next);
    setPending(true);
    onChange?.(next);
    try {
      await apiFetch<void>(`/me/favorites/${listingId}`, next ? { method: 'PUT', json: {} } : { method: 'DELETE' });
    } catch (err) {
      if (mounted.current) setFav(prev);
      onChange?.(prev);
      toast.error(apiErrorMessage(err));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <button
      type="button"
      aria-pressed={fav}
      aria-label={fav ? 'Favorilerden çıkar' : 'Favorilere ekle'}
      onClick={toggle}
      className={cn(
        'inline-grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text',
        fav && 'text-accent hover:text-accent',
        className,
      )}
    >
      <Heart aria-hidden className="size-[18px]" fill={fav ? 'currentColor' : 'none'} />
    </button>
  );
}
