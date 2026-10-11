'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Heart, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import type { FavoriteItem } from '@oto/shared';
import { EmptyState } from '@/components/empty-state';
import { ListingCardView } from '@/components/listing-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { apiErrorMessage } from '@/lib/messages';
import { panelKeys, useFavorites } from '@/lib/panel-queries';

const MAX_NOTE = 280;

function useSaveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note: string | null }) =>
      apiFetch<FavoriteItem>(`/me/favorites/${id}`, { method: 'PUT', json: { note } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: panelKeys.favorites() }),
  });
}

function NoteEditor({ id, note }: { id: number; note: string | null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? '');
  const save = useSaveNote();

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
        {note ? <p className="min-w-0 whitespace-pre-wrap break-words">{note}</p> : <p className="text-muted">Not eklenmemiş</p>}
        <button
          type="button"
          onClick={() => {
            setDraft(note ?? '');
            setEditing(true);
          }}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:text-text"
        >
          <Pencil aria-hidden className="size-3.5" />
          {note ? 'Notu düzenle' : 'Not ekle'}
        </button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { id, note: draft.trim() || null },
          {
            onSuccess: () => {
              setEditing(false);
              toast.success('Not kaydedildi');
            },
            onError: (err) => toast.error(apiErrorMessage(err)),
          },
        );
      }}
    >
      <label htmlFor={`note-${id}`} className="sr-only">
        Favori notu
      </label>
      <textarea
        id={`note-${id}`}
        value={draft}
        maxLength={MAX_NOTE}
        rows={3}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        className="w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-muted"
        placeholder="Örn. hafta sonu bakılacak"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="num text-xs text-muted" aria-live="polite">{`${draft.length}/${MAX_NOTE}`}</span>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Vazgeç
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending}>
            Notu kaydet
          </Button>
        </span>
      </div>
    </form>
  );
}

export default function FavoritesPage() {
  const q = useFavorites();
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());

  const items = useMemo(() => {
    const seen = new Set<number>();
    const out: FavoriteItem[] = [];
    for (const p of q.data?.pages ?? []) {
      for (const it of p.items) {
        if (!seen.has(it.listing.id)) {
          seen.add(it.listing.id);
          out.push(it);
        }
      }
    }
    return out;
  }, [q.data]);
  const visible = items.filter((it) => !hidden.has(it.listing.id));

  const setHide = (id: number, on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Kalp, FavoriteButton içinde DELETE/PUT yapar; sayfa kartı gizler ve geri alma teklif eder. */
  function onToggle(item: FavoriteItem, next: boolean) {
    const id = item.listing.id;
    if (next) {
      setHide(id, false);
      return;
    }
    setHide(id, true);
    toast('Favorilerden çıkarıldı', {
      action: {
        label: 'Geri al',
        onClick: () => {
          apiFetch(`/me/favorites/${id}`, { method: 'PUT', json: { note: item.note } })
            .then(() => {
              setHide(id, false);
              return qc.invalidateQueries({ queryKey: panelKeys.favorites() });
            })
            .catch((err: unknown) => toast.error(apiErrorMessage(err)));
        },
      },
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Favoriler</h1>
        <p className="mt-1 text-sm text-muted">Kaydettiğiniz ilanlar ve notlarınız.</p>
      </header>

      {q.isPending ? (
        <div aria-busy="true" aria-label="Favoriler yükleniyor" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[300px] rounded-lg" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState
          title="Favoriler yüklenemedi"
          description={apiErrorMessage(q.error)}
          action={<Button onClick={() => void q.refetch()}>Yeniden dene</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Heart className="size-5" />}
          title="Henüz favori ilanınız yok"
          description="Bir ilandaki kalbe dokunarak onu buraya kaydedin; fiyat değişimini ve notlarınızı tek yerde izleyin."
          action={
            <Button asChild>
              <Link href="/app/firsatlar">Fırsatlara göz at</Link>
            </Button>
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((it) => (
              <li key={it.listing.id} className="flex flex-col gap-2">
                <ListingCardView card={it.listing} onToggleFavorite={(next) => onToggle(it, next)} />
                <NoteEditor key={`${it.listing.id}:${it.note ?? ''}`} id={it.listing.id} note={it.note} />
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? 'Yükleniyor…' : 'Daha fazla yükle'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
