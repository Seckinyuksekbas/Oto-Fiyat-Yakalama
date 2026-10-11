'use client';
import { useState } from 'react';
import { AlertTriangle, Package, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { formatCount } from '@/components/admin/kpi-tile';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { AdminPlan } from '@/lib/admin-api';
import { CHANNEL_LABEL } from '@/lib/admin-ops-api';
import { useAdminPlans } from '@/lib/admin-queries';
import { formatTl } from '@/lib/format';
import { PlanForm, type PlanSaved } from './plan-form';

type Editing = { mode: 'create' } | { mode: 'edit'; plan: AdminPlan } | null;

export function PlansView() {
  const plans = useAdminPlans();
  const [editing, setEditing] = useState<Editing>(null);
  const [overLimit, setOverLimit] = useState<{ plan: string; count: number } | null>(null);

  const columns: DataColumn<AdminPlan>[] = [
    {
      id: 'plan',
      header: 'Paket',
      primary: true,
      cell: (p) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{p.name}</span>
          <span className="text-[13px] text-muted">{p.code}</span>
        </div>
      ),
    },
    {
      id: 'price',
      header: 'Aylık fiyat',
      numeric: true,
      cell: (p) => (p.priceMonthly === 0 ? <span className="font-sans text-muted">Ücretsiz</span> : formatTl(p.priceMonthly)),
    },
    {
      id: 'limits',
      header: 'Limitler',
      cell: (p) => (
        <span className="text-[13px] leading-snug">
          <span className="num">{formatCount(p.limits.maxSearchProfiles)}</span> profil,{' '}
          <span className="num">{formatCount(p.limits.maxNotificationsPerDay)}</span> bildirim/gün,{' '}
          {p.limits.opportunitiesDelayHours === 0 ? (
            'anlık fırsat'
          ) : (
            <>
              <span className="num">{p.limits.opportunitiesDelayHours}</span> sa gecikme
            </>
          )}
        </span>
      ),
    },
    { id: 'channels', header: 'Kanallar', cell: (p) => p.limits.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(', ') },
    { id: 'subs', header: 'Aktif abone', numeric: true, cell: (p) => formatCount(p.activeSubscriptions) },
    {
      id: 'status',
      header: 'Durum',
      cell: (p) => <StatusBadge status={p.isActive ? 'ACTIVE' : 'PAUSED'} label={p.isActive ? 'Açık' : 'Kapalı'} />,
    },
    {
      id: 'actions',
      header: 'İşlem',
      srOnlyHeader: true,
      cell: (p) => (
        <Button variant="secondary" size="sm" aria-label={`${p.code} paketini düzenle`} onClick={() => setEditing({ mode: 'edit', plan: p })}>
          Düzenle
        </Button>
      ),
    },
  ];

  const onSaved = (r: PlanSaved) => {
    setEditing(null);
    toast.success(r.created ? 'Paket oluşturuldu' : 'Paket kaydedildi', { description: r.plan.name });
    setOverLimit(r.usersOverProfileLimit > 0 ? { plan: r.plan.name, count: r.usersOverProfileLimit } : null);
  };

  const title = editing?.mode === 'edit' ? `Paketi düzenle: ${editing.plan.name}` : 'Yeni paket';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="sr-only">Paketler</h1>
          <p className="max-w-[68ch] text-[13px] text-muted">
            Limit değişikliği kaydedildiği anda yeni isteklerde geçerli olur. Kullanıcıya özel geçersiz kılmalar paket
            değerinin önündedir.
          </p>
        </div>
        <Button onClick={() => setEditing({ mode: 'create' })}>
          <Plus aria-hidden />
          Yeni paket
        </Button>
      </div>

      {overLimit ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <p className="flex-1 text-warning-text">
            {formatCount(overLimit.count)} kullanıcının aktif arama profili sayısı yeni sınırı aşıyor ({overLimit.plan}). Profiller
            hemen duraklatılmaz; fazlası bir sonraki abonelik değişiminde ya da günlük abonelik taramasında en yeniden başlayarak
            duraklatılır.
          </p>
          <Button variant="ghost" size="sm" aria-label="Uyarıyı kapat" onClick={() => setOverLimit(null)}>
            <X aria-hidden />
          </Button>
        </div>
      ) : null}

      <DataTable
        caption="Paketler"
        columns={columns}
        rowKey={(p) => p.id}
        data={plans.data}
        isPending={plans.isPending}
        isFetching={plans.isFetching && !plans.isPending}
        isError={plans.isError}
        onRetry={() => void plans.refetch()}
        page={1}
        pageSize={100}
        onPageChange={() => undefined}
        empty={{ icon: <Package className="size-5" />, title: 'Paket yok', description: 'FREE paketi tohum verisiyle gelir; yeni paket ekleyin.' }}
      />

      <Dialog open={editing !== null} onOpenChange={(o) => (o ? undefined : setEditing(null))}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader className="pr-6">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {editing?.mode === 'edit'
                ? `${formatCount(editing.plan.activeSubscriptions)} aktif abonelik bu paketi kullanıyor.`
                : 'Kod oluşturulduktan sonra değiştirilemez.'}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <PlanForm
              key={editing.mode === 'edit' ? editing.plan.id : 'new'}
              plan={editing.mode === 'edit' ? editing.plan : undefined}
              onSaved={onSaved}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
