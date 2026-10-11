'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Car, FileWarning, Search } from 'lucide-react';
import { AnalysisCell, ListingStatusBadge, When } from '@/components/admin/catalog/cells';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ADMIN_PAGE_SIZE } from '@/lib/admin-api';
import type { AdminIssueRow, AdminIssuesQuery, AdminListingRow, AdminListingsQuery, ListingStatus } from '@/lib/admin/catalog-api';
import { useAdminListingIssues, useAdminListings, useAdminSources } from '@/lib/admin/catalog-queries';
import { formatKm, formatTl } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';

const listingColumns: DataColumn<AdminListingRow>[] = [
  {
    id: 'title',
    header: 'İlan',
    primary: true,
    cell: (l) => (
      <div className="flex min-w-0 flex-col">
        <Link href={`/admin/ilanlar/${l.id}`} className="truncate font-medium hover:text-accent">
          {l.title}
        </Link>
        <span className="truncate text-[13px] text-muted">
          <span className="num">{l.year}</span>, <span className="num">{formatKm(l.km)}</span>
          {l.city ? `, ${l.city}` : ''}
        </span>
      </div>
    ),
  },
  { id: 'source', header: 'Kaynak', cell: (l) => <span className="text-[13px]">{l.sourceCode}</span> },
  { id: 'price', header: 'Fiyat', numeric: true, cell: (l) => formatTl(l.price) },
  { id: 'analysis', header: 'Analiz', cell: (l) => <AnalysisCell a={l.analysis} /> },
  { id: 'status', header: 'Durum', cell: (l) => <ListingStatusBadge status={l.status} /> },
  {
    id: 'issues',
    header: 'Sorun',
    numeric: true,
    cell: (l) => (l.issueCount > 0 ? <span className="text-warning-text">{l.issueCount}</span> : <span className="text-muted">0</span>),
  },
  { id: 'firstSeenAt', header: 'İlk görülme', cell: (l) => <When iso={l.firstSeenAt} /> },
];

const issueColumns: DataColumn<AdminIssueRow>[] = [
  {
    id: 'problem',
    header: 'Sorun',
    primary: true,
    cell: (i) => (
      <div className="flex min-w-0 flex-col">
        <span className="break-words">{i.problem}</span>
        <span className="text-[13px] text-muted">
          Alan: <code className="num">{i.field}</code>
        </span>
      </div>
    ),
  },
  { id: 'source', header: 'Kaynak', cell: (i) => <span className="text-[13px]">{i.sourceCode}</span> },
  {
    id: 'externalId',
    header: 'Kaynaktaki kimlik',
    cell: (i) =>
      i.listingId ? (
        <Link href={`/admin/ilanlar/${i.listingId}`} className="num hover:text-accent">
          {i.externalId ?? `#${i.listingId}`}
        </Link>
      ) : (
        <span className="num">{i.externalId ?? 'yok'}</span>
      ),
  },
  {
    id: 'raw',
    header: 'Ham parça',
    cell: (i) =>
      i.rawSnippet ? (
        <code className="line-clamp-2 block max-w-[36ch] break-all text-[12px] text-muted">{i.rawSnippet}</code>
      ) : (
        <span className="text-muted">yok</span>
      ),
  },
  { id: 'createdAt', header: 'Zaman', cell: (i) => <When iso={i.createdAt} /> },
];

type ListingFilters = Omit<AdminListingsQuery, 'page' | 'pageSize' | 'q'>;

function useSourceOptions() {
  const sources = useAdminSources();
  return (sources.data?.items ?? []).map((s) => ({ value: String(s.id), label: s.name }));
}

function ListingsTab() {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [filters, setFilters] = useState<ListingFilters>({});
  const [page, setPage] = useState(1);
  const sourceOptions = useSourceOptions();
  useEffect(() => setPage(1), [q]);

  const query: AdminListingsQuery = { ...filters, ...(q ? { q } : {}), page, pageSize: ADMIN_PAGE_SIZE };
  const listings = useAdminListings(query);
  const setFilter = <K extends keyof ListingFilters>(k: K, v: ListingFilters[K] | undefined) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtered = Boolean(q || filters.source || filters.status || filters.hasIssues);

  return (
    <div className="flex flex-col gap-5">
      <form role="search" aria-label="İlan süzgeçleri" className="flex flex-wrap items-end gap-x-4 gap-y-3" onSubmit={(e) => e.preventDefault()}>
        <div className="relative w-full sm:w-72">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            aria-label="Başlıkta ara"
            placeholder="Başlıkta ara"
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.target.value)}
            className="h-9 pl-9"
          />
        </div>
        <FilterSelect
          label="Kaynak"
          value={filters.source ? String(filters.source) : undefined}
          onChange={(v) => setFilter('source', v ? Number(v) : undefined)}
          options={sourceOptions}
        />
        <FilterSelect
          label="Durum"
          value={filters.status}
          onChange={(v) => setFilter('status', v as ListingStatus | undefined)}
          options={[
            { value: 'ACTIVE', label: 'Aktif' },
            { value: 'REMOVED', label: 'Yayından kalktı' },
          ]}
        />
        <FilterSelect
          label="Sorun kaydı"
          value={filters.hasIssues}
          onChange={(v) => setFilter('hasIssues', v as 'true' | 'false' | undefined)}
          options={[
            { value: 'true', label: 'Sorunlu' },
            { value: 'false', label: 'Sorunsuz' },
          ]}
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
        caption="İlanlar"
        columns={listingColumns}
        rowKey={(l) => l.id}
        data={listings.data}
        isPending={listings.isPending}
        isFetching={listings.isFetching && !listings.isPending}
        isError={listings.isError}
        onRetry={() => void listings.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        empty={{
          icon: <Car className="size-5" />,
          title: filtered ? 'Bu süzgeçlere uyan ilan yok' : 'Henüz ilan toplanmadı',
          description: filtered ? 'Arama metnini kısaltın ya da süzgeçleri temizleyin.' : 'Bir kaynak etkinleştirildiğinde ilk tarama sonrası ilanlar burada görünür.',
        }}
      />
    </div>
  );
}

function IssuesTab({ active }: { active: boolean }) {
  const [filters, setFilters] = useState<Omit<AdminIssuesQuery, 'page' | 'pageSize'>>({});
  const [fieldText, setFieldText] = useState('');
  const field = useDebounced(fieldText.trim(), 300);
  const [page, setPage] = useState(1);
  const sourceOptions = useSourceOptions();
  useEffect(() => setPage(1), [field]);
  const query: AdminIssuesQuery = { ...filters, ...(field ? { field } : {}), page, pageSize: ADMIN_PAGE_SIZE };
  const issues = useAdminListingIssues(query, active);

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[72ch] text-sm text-muted">
        Ayrıştırılamayan ya da doğrulamadan geçemeyen ilan kartları. Aynı alanda yığılma varsa kaynak sayfasının yapısı değişmiş olabilir.
      </p>
      <form role="search" aria-label="Sorunlu kayıt süzgeçleri" className="flex flex-wrap items-end gap-x-4 gap-y-3" onSubmit={(e) => e.preventDefault()}>
        <FilterSelect
          label="Kaynak"
          value={filters.source ? String(filters.source) : undefined}
          onChange={(v) => {
            setFilters((f) => ({ ...f, source: v ? Number(v) : undefined }));
            setPage(1);
          }}
          options={sourceOptions}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="issue-field" className="text-[13px] text-muted">
            Alan
          </label>
          <Input id="issue-field" value={fieldText} maxLength={100} placeholder="price, year…" onChange={(e) => setFieldText(e.target.value)} className="h-9 w-44" />
        </div>
      </form>
      <DataTable
        caption="Sorunlu kayıtlar"
        columns={issueColumns}
        rowKey={(i) => i.id}
        data={issues.data}
        isPending={issues.isPending}
        isFetching={issues.isFetching && !issues.isPending}
        isError={issues.isError}
        onRetry={() => void issues.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        empty={{ icon: <FileWarning className="size-5" />, title: 'Sorunlu kayıt yok', description: 'Tüm ilan kartları sorunsuz ayrıştırıldı.' }}
      />
    </div>
  );
}

export function AdminListingsView() {
  const [tab, setTab] = useState('listings');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">İlanlar</h1>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="İlan görünümü">
          <TabsTrigger value="listings">İlanlar</TabsTrigger>
          <TabsTrigger value="issues">Sorunlu kayıtlar</TabsTrigger>
        </TabsList>
        <TabsContent value="listings">
          <ListingsTab />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesTab active={tab === 'issues'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
