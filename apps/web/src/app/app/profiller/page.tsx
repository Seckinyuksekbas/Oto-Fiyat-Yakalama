'use client';
import { useState } from 'react';
import Link from 'next/link';
import { BellRing, Pencil, Plus, Radar, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { FUEL_LABEL, GEAR_LABEL, formatKm, formatShortTl } from '@/lib/format';
import { apiErrorMessage } from '@/lib/messages';
import {
  limitNotice,
  useDeleteProfile,
  useProfileLimits,
  useProfiles,
  useSetProfileStatus,
  type ProfileLimits,
  type SearchProfile,
} from '@/lib/profile-queries';

function filterChips(p: SearchProfile): string[] {
  const chips: string[] = [];
  const car = [p.make, p.model].filter(Boolean).join(' ');
  chips.push(car || 'Tüm markalar');
  if (p.yearMin || p.yearMax) chips.push(`${p.yearMin ?? ''}–${p.yearMax ?? ''}`);
  if (p.kmMax) chips.push(`en çok ${formatKm(p.kmMax)}`);
  if (p.priceMin || p.priceMax) {
    chips.push(`${p.priceMin ? formatShortTl(Number(p.priceMin)) : ''}–${p.priceMax ? formatShortTl(Number(p.priceMax)) : ''}`);
  }
  if (p.fuels.length) chips.push(p.fuels.map((f) => FUEL_LABEL[f] ?? f).join(', '));
  if (p.transmissions.length) chips.push(p.transmissions.map((t) => GEAR_LABEL[t] ?? t).join(', '));
  if (p.cities.length) chips.push(p.cities.join(', '));
  if (p.excludeDamaged) chips.push('Hasarsız');
  return chips;
}

function criterion(p: SearchProfile): string {
  return p.minDiscountPct > 0 ? `%${Math.round(p.minDiscountPct * 100)}+ indirim` : 'Tüm yeni ilanlar';
}

function ProfileCard({ p, onToggle, pending, onDelete }: {
  p: SearchProfile;
  onToggle: (active: boolean) => void;
  pending: boolean;
  onDelete: () => void;
}) {
  const active = p.status === 'ACTIVE';
  return (
    <li className={`flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 ${active ? '' : 'opacity-80'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold leading-snug">{p.name}</h2>
          <p className="mt-0.5 text-sm text-muted">
            {criterion(p)}
            {!active && <span className="ml-2 text-warning-text">Duraklatıldı</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted" aria-hidden>{active ? 'Aktif' : 'Duraklatıldı'}</span>
          <Switch
            aria-label={`${p.name} durumu`}
            checked={active}
            disabled={pending}
            onCheckedChange={onToggle}
          />
        </div>
      </div>

      <ul aria-label="Filtreler" className="flex flex-wrap gap-1.5">
        {filterChips(p).map((c) => (
          <li key={c}>
            <Badge>{c}</Badge>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <BellRing aria-hidden className="size-3.5" />
          {p.channels.includes('TELEGRAM') ? 'Uygulama içi, Telegram' : 'Uygulama içi'}
        </p>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/app/eslesmeler?profileId=${encodeURIComponent(p.id)}`}>Eşleşmeleri gör</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/app/profiller/${encodeURIComponent(p.id)}`} aria-label={`${p.name} profilini düzenle`}>
              <Pencil aria-hidden /> Düzenle
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`${p.name} profilini sil`} className="hover:text-danger-text">
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
    </li>
  );
}

function NewProfileAction({ limits, used }: { limits: ProfileLimits | null; used: number }) {
  const full = !!limits && used >= limits.maxProfiles;
  if (!full) {
    return (
      <Button asChild>
        <Link href="/app/profiller/yeni">
          <Plus aria-hidden /> Yeni profil
        </Link>
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1.5 sm:max-w-[34ch]">
      <Button disabled>
        <Plus aria-hidden /> Yeni profil
      </Button>
      <p className="text-right text-xs leading-relaxed text-muted">
        {limits.emailVerified ? (
          <>
            Planınızın profil sınırı doldu. <Link href="/app/abonelik" className="text-accent underline underline-offset-2">Planı yükseltin</Link> ya da bir profili silin.
          </>
        ) : (
          'E-postanızı doğrulayın: doğrulanmamış hesaplar yalnızca 1 profil oluşturabilir.'
        )}
      </p>
    </div>
  );
}

export default function ProfilesPage() {
  const q = useProfiles();
  const { limits } = useProfileLimits();
  const setStatus = useSetProfileStatus();
  const del = useDeleteProfile();
  const [notice, setNotice] = useState<{ message: string; href: string; cta: string } | null>(null);
  const [target, setTarget] = useState<SearchProfile | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const items = q.data?.items ?? [];

  const toggle = (p: SearchProfile, active: boolean) => {
    setNotice(null);
    setPendingId(p.id);
    setStatus.mutate(
      { id: p.id, active },
      {
        onSuccess: () => toast.success(active ? 'Profil sürdürüldü' : 'Profil duraklatıldı'),
        onError: (err) =>
          setNotice(limitNotice(err) ?? { message: apiErrorMessage(err), href: '/app/abonelik', cta: 'Planları gör' }),
        onSettled: () => setPendingId(null),
      },
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Arama profilleri</h1>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">
            Her profil bir arama ölçütüdür; uyan yeni ilanlar size bildirilir.
            {limits && q.data ? <span className="num ml-2 text-text">{`${items.length}/${limits.maxProfiles} profil`}</span> : null}
          </p>
        </div>
        <NewProfileAction limits={limits} used={items.length} />
      </header>

      {notice && (
        <p role="alert" className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
          {notice.message}{' '}
          <Link href={notice.href} className="font-medium text-accent underline underline-offset-2">{notice.cta}</Link>
        </p>
      )}

      {q.isPending ? (
        <div aria-busy="true" aria-label="Profiller yükleniyor" className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-[170px] rounded-lg" />
          <Skeleton className="h-[170px] rounded-lg" />
        </div>
      ) : q.isError ? (
        <EmptyState title="Profiller yüklenemedi" description={apiErrorMessage(q.error)} action={<Button onClick={() => void q.refetch()}>Yeniden dene</Button>} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Radar className="size-5" />}
          title="Henüz arama profiliniz yok"
          description="Marka, model ve fiyat ölçütü verin; uyan yeni ilanlar yayınlanır yayınlanmaz size haber verelim."
          action={
            <Button asChild>
              <Link href="/app/profiller/yeni">İlk profilinizi oluşturun</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((p) => (
            <ProfileCard key={p.id} p={p} pending={pendingId === p.id} onToggle={(a) => toggle(p, a)} onDelete={() => {
                del.reset();
                setTarget(p);
              }} />
          ))}
        </ul>
      )}

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Profili sil</DialogTitle>
            <DialogDescription>
              {target ? `"${target.name}" silinecek ve bu profil için bildirim gelmeyecek. Bu işlem geri alınamaz.` : ''}
            </DialogDescription>
          </DialogHeader>
          {del.isError && <p role="alert" className="text-sm text-danger-text">{apiErrorMessage(del.error)}</p>}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setTarget(null)}>Vazgeç</Button>
            <Button
              variant="danger"
              disabled={del.isPending}
              onClick={() => {
                if (!target) return;
                del.mutate(target.id, {
                  onSuccess: () => {
                    toast.success('Profil silindi');
                    setTarget(null);
                  },
                });
              }}
            >
              Sil
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
