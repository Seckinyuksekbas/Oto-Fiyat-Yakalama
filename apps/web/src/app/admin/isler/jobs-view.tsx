'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { TRIGGER_LABEL, When } from '@/components/admin/catalog/cells';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { formatDurationMs } from '@/components/admin/kpi-tile';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { ADMIN_PAGE_SIZE } from '@/lib/admin-api';
import type { AdminJobRow, AdminJobsQuery, JobStatus, JobTrigger } from '@/lib/admin/catalog-api';
import { useAdminJobs, useAdminSources } from '@/lib/admin/catalog-queries';

export function jobDuration(j: Pick<AdminJobRow, 'startedAt' | 'finishedAt'>): number | null {
  if (!j.startedAt || !j.finishedAt) return null;
  const ms = Date.parse(j.finishedAt) - Date.parse(j.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

const columns: DataColumn<AdminJobRow>[] = [
  {
    id: 'job',
    header: 'İş',
    primary: true,
    cell: (j) => (
      <div className="flex min-w-0 flex-col">
        <Link href={`/admin/isler/${j.id}`} className="font-medium hover:text-accent">
          İş #{j.id}
        </Link>
        <span className="truncate text-[13px] text-muted">
          {j.sourceName}, {TRIGGER_LABEL[j.trigger] ?? j.trigger}
          {j.dryRun ? ', dry-run' : ''}
        </span>
      </div>
    ),
  },
  { id: 'status', header: 'Durum', cell: (j) => <StatusBadge status={j.status} /> },
  { id: 'pages', header: 'Sayfa', numeric: true, cell: (j) => j.pagesFetched },
  {
    id: 'listings',
    header: 'Yeni / güncel / kalkan',
    numeric: true,
    cell: (j) => (j.dryRun ? <span className="text-muted">yazılmadı</span> : `${j.listingsNew} / ${j.listingsUpdated} / ${j.listingsRemoved}`),
  },
  {
    id: 'errors',
    header: 'Hata',
    numeric: true,
    cell: (j) => (j.errorsCount > 0 ? <span className="text-danger-text">{j.errorsCount}</span> : '0'),
  },
  {
    id: 'duration',
    header: 'Süre',
    numeric: true,
    cell: (j) => {
      const ms = jobDuration(j);
      return ms === null ? <span className="text-muted">—</span> : formatDurationMs(ms);
    },
  },
  { id: 'createdAt', header: 'Oluşturuldu', cell: (j) => <When iso={j.createdAt} /> },
];

type Filters = Omit<AdminJobsQuery, 'page' | 'pageSize'>;

export function AdminJobsView({ initialSource }: { initialSource?: number }) {
  const [filters, setFilters] = useState<Filters>(initialSource ? { source: initialSource } : {});
  const [page, setPage] = useState(1);
  const sources = useAdminSources();
  const query: AdminJobsQuery = { ...filters, page, pageSize: ADMIN_PAGE_SIZE };
  const jobs = useAdminJobs(query);
  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K] | undefined) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtered = Boolean(filters.source || filters.status || filters.trigger);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">İşler</h1>
      <form role="search" aria-label="İş süzgeçleri" className="flex flex-wrap items-end gap-x-4 gap-y-3" onSubmit={(e) => e.preventDefault()}>
        <FilterSelect
          label="Kaynak"
          value={filters.source ? String(filters.source) : undefined}
          onChange={(v) => setFilter('source', v ? Number(v) : undefined)}
          options={(sources.data?.items ?? []).map((s) => ({ value: String(s.id), label: s.name }))}
        />
        <FilterSelect
          label="Durum"
          value={filters.status}
          onChange={(v) => setFilter('status', v as JobStatus | undefined)}
          options={[
            { value: 'QUEUED', label: 'Sırada' },
            { value: 'RUNNING', label: 'Çalışıyor' },
            { value: 'SUCCEEDED', label: 'Başarılı' },
            { value: 'PARTIAL', label: 'Kısmi' },
            { value: 'FAILED', label: 'Başarısız' },
          ]}
        />
        <FilterSelect
          label="Tetikleyici"
          value={filters.trigger}
          onChange={(v) => setFilter('trigger', v as JobTrigger | undefined)}
          options={[
            { value: 'SCHEDULED', label: 'Zamanlanmış' },
            { value: 'MANUAL', label: 'Elle (test taraması dahil)' },
          ]}
        />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => {
              setFilters({});
              setPage(1);
            }}
          >
            Süzgeçleri temizle
          </Button>
        ) : null}
      </form>
      <DataTable
        caption="Toplama işleri"
        columns={columns}
        rowKey={(j) => j.id}
        data={jobs.data}
        isPending={jobs.isPending}
        isFetching={jobs.isFetching && !jobs.isPending}
        isError={jobs.isError}
        onRetry={() => void jobs.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        empty={{
          icon: <ListChecks className="size-5" />,
          title: filtered ? 'Bu süzgeçlere uyan iş yok' : 'Henüz toplama işi yok',
          description: filtered ? 'Süzgeçleri temizleyin.' : 'Zamanlayıcı etkin kaynaklar için iş oluşturdukça burada listelenir.',
        }}
      />
    </div>
  );
}
