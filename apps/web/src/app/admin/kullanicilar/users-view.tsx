'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, Users } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ADMIN_PAGE_SIZE, type AdminRole, type AdminUserRow, type AdminUserStatus, type AdminUsersQuery } from '@/lib/admin-api';
import { useAdminPlans, useAdminUsers } from '@/lib/admin-queries';
import { formatDateTime, formatRelative } from '@/lib/format';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const columns: DataColumn<AdminUserRow>[] = [
  {
    id: 'user',
    header: 'Kullanıcı',
    primary: true,
    cell: (u) => (
      <div className="flex min-w-0 flex-col">
        <Link href={`/admin/kullanicilar/${encodeURIComponent(u.id)}`} className="truncate font-medium hover:text-accent">
          {u.name}
        </Link>
        <span className="truncate text-[13px] text-muted">{u.email}</span>
      </div>
    ),
  },
  { id: 'role', header: 'Rol', cell: (u) => <StatusBadge status={u.role} /> },
  { id: 'status', header: 'Durum', cell: (u) => <StatusBadge status={u.status} /> },
  { id: 'plan', header: 'Paket', cell: (u) => u.planCode },
  {
    id: 'createdAt',
    header: 'Kayıt',
    cell: (u) => <time dateTime={u.createdAt}>{formatDateTime(u.createdAt).slice(0, 10)}</time>,
  },
  {
    id: 'lastLoginAt',
    header: 'Son giriş',
    cell: (u) =>
      u.lastLoginAt ? (
        <time dateTime={u.lastLoginAt} title={formatDateTime(u.lastLoginAt)}>
          {formatRelative(u.lastLoginAt)}
        </time>
      ) : (
        <span className="text-muted">Hiç giriş yapmadı</span>
      ),
  },
];

type Filters = Omit<AdminUsersQuery, 'page' | 'pageSize'>;

export function AdminUsersView() {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const plans = useAdminPlans();

  // Arama metni değişince ilk sayfaya dönülür.
  useEffect(() => setPage(1), [q]);

  const query: AdminUsersQuery = { ...filters, ...(q ? { q } : {}), page, pageSize: ADMIN_PAGE_SIZE };
  const users = useAdminUsers(query);

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K] | undefined) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtered = Boolean(q || filters.status || filters.role || filters.plan);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">Kullanıcılar</h1>
      <form
        role="search"
        aria-label="Kullanıcı süzgeçleri"
        className="flex flex-wrap items-end gap-x-4 gap-y-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="relative w-full sm:w-72">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            aria-label="Ad veya e-posta ara"
            placeholder="Ad veya e-posta"
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.target.value)}
            className="h-9 pl-9"
          />
        </div>
        <FilterSelect
          label="Durum"
          allLabel="Silinenler hariç tümü"
          value={filters.status}
          onChange={(v) => setFilter('status', v as AdminUserStatus | undefined)}
          options={[
            { value: 'ACTIVE', label: 'Aktif' },
            { value: 'SUSPENDED', label: 'Askıda' },
            { value: 'DELETED', label: 'Silinmiş' },
          ]}
        />
        <FilterSelect
          label="Rol"
          value={filters.role}
          onChange={(v) => setFilter('role', v as AdminRole | undefined)}
          options={[
            { value: 'USER', label: 'Kullanıcı' },
            { value: 'ADMIN', label: 'Admin' },
            { value: 'SUPER_ADMIN', label: 'Süper admin' },
          ]}
        />
        <FilterSelect
          label="Paket"
          value={filters.plan}
          onChange={(v) => setFilter('plan', v)}
          options={(plans.data?.items ?? []).map((p) => ({ value: p.code, label: p.name }))}
        />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => {
              setText('');
              setFilters({});
              setPage(1);
            }}
          >
            Süzgeçleri temizle
          </Button>
        ) : null}
      </form>

      <DataTable
        caption="Kullanıcılar"
        columns={columns}
        rowKey={(u) => u.id}
        data={users.data}
        isPending={users.isPending}
        isFetching={users.isFetching && !users.isPending}
        isError={users.isError}
        onRetry={() => void users.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        empty={{
          icon: <Users className="size-5" />,
          title: filtered ? 'Bu süzgeçlere uyan kullanıcı yok' : 'Henüz kullanıcı yok',
          description: filtered ? 'Arama metnini kısaltın ya da süzgeçleri temizleyin.' : undefined,
        }}
      />
    </div>
  );
}
