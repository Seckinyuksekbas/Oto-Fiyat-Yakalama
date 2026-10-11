'use client';
import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { Button } from '@/components/ui/button';
import { adminErrorMessage } from '@/lib/admin-api';
import type { AdminSource } from '@/lib/admin/catalog-api';
import { useSourceAction } from '@/lib/admin/catalog-queries';

export const PERMISSION_MISSING = 'İzin doğrulanmadı: kaynak, izin notu doğrulanıp kaydedilmeden etkinleştirilemez.';

/** Kaynak duraklatılmış sayılır: zamanlayıcı dışı (`isActive=false`) ya da engel/duraklatma sağlığı. */
export function isRunning(s: Pick<AdminSource, 'isActive' | 'health'>): boolean {
  return s.isActive && s.health !== 'PAUSED';
}

/**
 * Etkinleştir / Duraklat. Etik kural: izin doğrulanmamış kaynak etkinleştirilemez (API de 409 döner);
 * düğme devre dışı kalır ve nedeni metinle yazılır. Duraklatma onay ister.
 */
export function SourceToggle({ source, size = 'sm' }: { source: AdminSource; size?: 'sm' | 'md' }) {
  const action = useSourceAction(source.id);
  const [confirmPause, setConfirmPause] = useState(false);
  const running = isRunning(source);
  const permitted = source.permissionVerifiedAt !== null;

  const activate = async () => {
    try {
      await action.mutateAsync('activate');
      toast.success('Kaynak etkinleştirildi');
    } catch (err) {
      toast.error(adminErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {running ? (
        <Button variant="secondary" size={size} className="w-fit" disabled={action.isPending} onClick={() => setConfirmPause(true)}>
          <Pause aria-hidden />
          Duraklat
        </Button>
      ) : (
        <Button variant="secondary" size={size} className="w-fit" disabled={!permitted || action.isPending} onClick={() => void activate()}>
          <Play aria-hidden />
          Etkinleştir
        </Button>
      )}
      {!running && !permitted ? <p className="max-w-[44ch] text-[13px] text-warning-text">{PERMISSION_MISSING}</p> : null}
      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title={`${source.name} duraklatılsın mı?`}
        description="Zamanlanmış taramalar durur; mevcut ilanlar yerinde kalır. Yeniden etkinleştirince ardışık hata sayacı sıfırlanır."
        confirmLabel="Duraklat"
        onConfirm={async () => {
          await action.mutateAsync('pause');
          toast.success('Kaynak duraklatıldı');
        }}
      />
    </div>
  );
}
