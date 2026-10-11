'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { KpiGrid, KpiTile, formatCount } from '@/components/admin/kpi-tile';
import { StatusBadge, STATUS_DEFS } from '@/components/admin/status-badge';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { adminErrorMessage, type AdminRole, type AdminUserDetail, type AdminUserNotification } from '@/lib/admin-api';
import {
  useAdminPlans,
  useAdminRole,
  useAdminUser,
  useAdminUserAction,
  useAdminUserNotifications,
  useAdminUserProfiles,
  useAdminUserUsage,
} from '@/lib/admin-queries';
import { formatDateTime, formatRelative } from '@/lib/format';
import { describeNotification } from '@/lib/notification-text';
import { SubscriptionForm } from './subscription-form';

const NOTIF_PAGE_SIZE = 10;

const KIND_LABEL: Record<string, string> = { MATCH: 'Eşleşme', SYSTEM_ALERT: 'Sistem', SECURITY: 'Güvenlik' };
const CHANNEL_LABEL: Record<string, string> = { IN_APP: 'Uygulama içi', TELEGRAM: 'Telegram', EMAIL: 'E-posta' };
const ROLE_OPTIONS: Array<{ value: AdminRole; label: string }> = [
  { value: 'USER', label: 'Kullanıcı' },
  { value: 'ADMIN', label: 'Admin' },
  { value: 'SUPER_ADMIN', label: 'Süper admin' },
];

const day = (iso: string) => formatDateTime(iso).slice(0, 10);

// ---------------------------------------------------------------- başlık

function Header({ d }: { d: AdminUserDetail }) {
  const u = d.user;
  return (
    <header className="flex flex-col gap-4">
      <Link href="/admin/kullanicilar" className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" />
        Kullanıcılar
      </Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight break-words">{u.name}</h1>
          <StatusBadge status={u.status} />
          <StatusBadge status={u.role} />
          {!u.emailVerifiedAt && u.status !== 'DELETED' ? <StatusBadge status="UNVERIFIED" label="E-posta doğrulanmadı" tone="warning" /> : null}
        </div>
        <p className="text-sm text-muted break-all">{u.email}</p>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
          <div className="flex gap-1.5">
            <dt>Kayıt</dt>
            <dd className="text-text">
              <time dateTime={u.createdAt}>{day(u.createdAt)}</time>
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Son giriş</dt>
            <dd className="text-text">
              {u.lastLoginAt ? (
                <time dateTime={u.lastLoginAt} title={formatDateTime(u.lastLoginAt)}>
                  {formatRelative(u.lastLoginAt)}
                </time>
              ) : (
                'hiç'
              )}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Açık oturum</dt>
            <dd className="num text-text">{formatCount(d.counts.activeSessions)}</dd>
          </div>
        </dl>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- kullanım

function Usage({ id }: { id: string }) {
  const q = useAdminUserUsage(id);
  if (q.isPending) return <Skeleton className="h-[92px] w-full rounded-lg" />;
  if (q.isError) return <p className="text-sm text-muted">Kullanım bilgisi yüklenemedi.</p>;
  const u = q.data;
  return (
    <KpiGrid label="Kullanım" className="md:grid-cols-4">
      <KpiTile label="Aktif profil" value={`${formatCount(u.activeProfiles)}/${formatCount(u.plan.limits.maxSearchProfiles)}`} numeric hint={`${formatCount(u.searchProfiles)} profil toplam`} />
      <KpiTile
        label="Bugünkü bildirim"
        value={`${formatCount(u.notificationsToday)}/${formatCount(u.plan.limits.maxNotificationsPerDay)}`}
        numeric
        hint="Telegram ve e-posta"
      />
      <KpiTile label="Eşleşme (7 gün)" value={u.matches7d} />
      <KpiTile label="Geçerli paket" value={u.plan.name} hint={u.plan.endsAt ? `${day(u.plan.endsAt)} tarihine kadar` : 'Süresiz'} />
    </KpiGrid>
  );
}

// ---------------------------------------------------------------- profiller ve bildirimler

function Profiles({ id }: { id: string }) {
  const q = useAdminUserProfiles(id);
  return (
    <section aria-labelledby="profiller" className="flex flex-col gap-3">
      <h2 id="profiller" className="font-display text-base font-semibold">
        Arama profilleri
      </h2>
      {q.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-muted">Profiller yüklenemedi.</p>
      ) : q.data.items.length === 0 ? (
        <p className="text-sm text-muted">Bu kullanıcının arama profili yok.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
          {q.data.items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <p className="truncate text-[13px] text-muted">
                  {[p.make, p.model].filter(Boolean).join(' ') || 'Tüm markalar'}
                  {p.channels.length > 0 ? `, ${p.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(', ')}` : ''}
                </p>
              </div>
              <StatusBadge status={p.status} label={p.status === 'PAUSED' ? 'Duraklatıldı' : undefined} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const notifColumns: DataColumn<AdminUserNotification>[] = [
  {
    id: 'summary',
    header: 'Bildirim',
    primary: true,
    cell: (n) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{describeNotification(n).title}</span>
        <span className="text-[13px] text-muted">{KIND_LABEL[n.kind] ?? n.kind}</span>
      </div>
    ),
  },
  { id: 'channel', header: 'Kanal', cell: (n) => CHANNEL_LABEL[n.channel] ?? n.channel },
  { id: 'status', header: 'Durum', cell: (n) => <StatusBadge status={n.status} /> },
  { id: 'attempts', header: 'Deneme', numeric: true, cell: (n) => n.attempts },
  {
    id: 'error',
    header: 'Hata',
    cell: (n) =>
      n.lastError ? (
        <span className="line-clamp-2 max-w-[28ch] break-words text-[13px] text-danger-text">{n.lastError}</span>
      ) : (
        <span className="text-muted">yok</span>
      ),
  },
  {
    id: 'createdAt',
    header: 'Oluşturuldu',
    cell: (n) => (
      <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
        {formatRelative(n.createdAt)}
      </time>
    ),
  },
];

function Notifications({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const q = useAdminUserNotifications(id, { page, pageSize: NOTIF_PAGE_SIZE });
  return (
    <section aria-labelledby="bildirimler" className="flex flex-col gap-3">
      <h2 id="bildirimler" className="font-display text-base font-semibold">
        Bildirimler
      </h2>
      <DataTable
        caption="Kullanıcı bildirimleri"
        columns={notifColumns}
        rowKey={(n) => n.id}
        data={q.data}
        isPending={q.isPending}
        isFetching={q.isFetching && !q.isPending}
        isError={q.isError}
        onRetry={() => void q.refetch()}
        page={page}
        pageSize={NOTIF_PAGE_SIZE}
        onPageChange={setPage}
        empty={{ title: 'Bildirim yok', description: 'Bu kullanıcıya henüz bildirim gönderilmedi.' }}
      />
    </section>
  );
}

// ---------------------------------------------------------------- hesap işlemleri

type Dialog = null | 'suspend' | 'role' | 'delete';

function AccountActions({ d, isSelf, locked }: { d: AdminUserDetail; isSelf: boolean; locked: string | null }) {
  const { isSuperAdmin } = useAdminRole();
  const router = useRouter();
  const action = useAdminUserAction(d.user.id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [role, setRole] = useState<AdminRole>(d.user.role);
  const u = d.user;
  const suspended = u.status === 'SUSPENDED';
  const disabled = isSelf || locked !== null;

  const accessBtn = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);

  const activate = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await action.mutateAsync({ kind: 'activate' });
      toast.success('Kullanıcı etkinleştirildi');
      accessBtn.current?.focus();
    } catch (err) {
      toast.error(adminErrorMessage(err));
    } finally {
      busy.current = false;
    }
  };

  return (
    <section aria-labelledby="hesap-islemleri" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
      <h2 id="hesap-islemleri" className="font-display text-base font-semibold">
        Hesap işlemleri
      </h2>
      {locked ? (
        <p className="flex items-start gap-2 text-sm text-muted">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
          {locked}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Erişim</h3>
        <p className="text-[13px] text-muted">
          {suspended
            ? 'Hesap askıda: giriş yapamaz, bildirim almaz. Etkinleştirince eski oturumlar geri gelmez.'
            : 'Askıya alınan kullanıcı tüm oturumlarından çıkarılır ve bekleyen bildirimleri iptal edilir.'}
        </p>
        {/* Tek, kararlı düğme: durum değişince etiketi değişir ama DOM öğesi aynı kalır, odak kaybolmaz. */}
        <Button
          ref={accessBtn}
          variant={suspended ? 'secondary' : 'danger'}
          className="w-fit"
          disabled={disabled}
          aria-busy={(suspended && action.isPending) || undefined}
          onClick={() => (suspended ? void activate() : setDialog('suspend'))}
        >
          {suspended ? 'Etkinleştir' : 'Askıya al'}
        </Button>
        {isSelf ? <p className="text-[13px] text-muted">Kendi hesabınızda bu işlemler kapalıdır.</p> : null}
      </div>

      {isSuperAdmin ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Rol</h3>
          <div className="flex flex-wrap items-end gap-2">
            <FilterSelect
              label="Rol"
              allLabel={null}
              value={role}
              onChange={(v) => v && setRole(v as AdminRole)}
              options={ROLE_OPTIONS}
              disabled={disabled}
            />
            <Button variant="secondary" disabled={disabled || role === u.role} onClick={() => setDialog('role')}>
              Rolü değiştir
            </Button>
          </div>
          <p className="text-[13px] text-muted">Son aktif süper admin düşürülemez.</p>
        </div>
      ) : null}

      {isSuperAdmin ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium text-danger-text">Hesabı sil</h3>
          <p className="text-[13px] text-muted">
            Kişisel veriler anonimleştirilir, profiller ve oturumlar kaldırılır. Geri alınamaz.
          </p>
          <Button variant="danger" className="w-fit" disabled={disabled} onClick={() => setDialog('delete')}>
            Kullanıcıyı sil
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog === 'suspend'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Kullanıcı askıya alınsın mı?"
        description={`${u.name} tüm oturumlarından çıkarılır ve bekleyen bildirimleri iptal edilir. Daha sonra yeniden etkinleştirebilirsiniz.`}
        confirmLabel="Askıya al"
        tone="danger"
        returnFocusRef={accessBtn}
        onConfirm={async () => {
          await action.mutateAsync({ kind: 'suspend' });
          toast.success('Kullanıcı askıya alındı');
        }}
      />
      <ConfirmDialog
        open={dialog === 'role'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Rol değiştirilsin mi?"
        description={`${u.name}: ${STATUS_DEFS[u.role]?.label ?? u.role} rolünden ${STATUS_DEFS[role]?.label ?? role} rolüne geçer. Yetkiler bir sonraki istekte değişir.`}
        confirmLabel="Rolü değiştir"
        onConfirm={async () => {
          await action.mutateAsync({ kind: 'role', role });
          toast.success('Rol değiştirildi');
        }}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Kullanıcı silinsin mi?"
        description="Bu işlem geri alınamaz. Ad ve e-posta anonimleştirilir; denetim kaydı kalır."
        confirmLabel="Kalıcı olarak sil"
        tone="danger"
        confirmText={u.email}
        onConfirm={async () => {
          await action.mutateAsync({ kind: 'delete' });
          toast.success('Kullanıcı silindi');
          router.push('/admin/kullanicilar');
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------- sayfa

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-24 w-full max-w-xl" />
      <Skeleton className="h-[92px] w-full rounded-lg" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Skeleton className="h-[320px] rounded-lg" />
        <Skeleton className="h-[320px] rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Kullanıcı detayı. Kısıtlar API ile aynıdır, burada yalnızca görünürlük/ön bilgi olarak uygulanır:
 * kendi hesabında mutasyon yok (409), ADMIN bir SUPER_ADMIN'e dokunamaz (403), silinmiş hesap salt okunur (404).
 */
export function AdminUserDetailView({ id }: { id: string }) {
  const q = useAdminUser(id);
  const plans = useAdminPlans();
  const me = useAdminRole();

  if (q.isPending) return <DetailSkeleton />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <EmptyState
        title={notFound ? 'Kullanıcı bulunamadı' : 'Kullanıcı yüklenemedi'}
        description={notFound ? 'Bağlantı hatalı olabilir. Kullanıcı listesinden arayın.' : 'Bağlantınızı kontrol edip yeniden deneyin.'}
        action={
          notFound ? (
            <Button asChild variant="secondary">
              <Link href="/admin/kullanicilar">Kullanıcılara dön</Link>
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Yeniden dene
            </Button>
          )
        }
      />
    );
  }

  const d = q.data;
  const isSelf = me.userId === d.user.id;
  const deleted = d.user.status === 'DELETED';
  const locked = deleted
    ? 'Bu hesap silinmiş; kişisel veriler anonimleştirildi. Değişiklik yapılamaz.'
    : d.user.role === 'SUPER_ADMIN' && !me.isSuperAdmin
      ? 'Süper admin hesaplarını yalnızca süper adminler değiştirebilir.'
      : null;
  const subscriptionLock = isSelf ? 'Kendi aboneliğinizi değiştiremezsiniz.' : locked;

  return (
    <div className="flex flex-col gap-8">
      <Header d={d} />
      <Usage id={id} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          {plans.isPending ? (
            <Skeleton className="h-[260px] w-full rounded-lg" />
          ) : plans.isError ? (
            <p className="text-sm text-muted">Paketler yüklenemedi; abonelik düzenlenemiyor.</p>
          ) : (
            <SubscriptionForm
              key={JSON.stringify(d.subscription)}
              userId={id}
              detail={d}
              plans={plans.data.items}
              lockedReason={subscriptionLock}
            />
          )}
          <Profiles id={id} />
          <Notifications id={id} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {deleted ? null : <AccountActions d={d} isSelf={isSelf} locked={locked} />}
        </div>
      </div>
    </div>
  );
}
