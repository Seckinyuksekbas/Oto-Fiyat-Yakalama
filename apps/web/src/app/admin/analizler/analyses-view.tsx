'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Gauge } from 'lucide-react';
import { CONFIDENCE_OPTIONS, ConfidenceBadge, ScoreValue, When } from '@/components/admin/catalog/cells';
import { DataTable, type DataColumn } from '@/components/admin/data-table';
import { FilterSelect } from '@/components/admin/filter-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ADMIN_PAGE_SIZE } from '@/lib/admin-api';
import type { AdminAnalysesQuery, AdminAnalysisRow, Confidence } from '@/lib/admin/catalog-api';
import { useAdminAnalyses } from '@/lib/admin/catalog-queries';
import { formatDiscount, formatTl } from '@/lib/format';
import { MATCH_REASON_LABEL } from '@/lib/panel-queries';
import { useDebounced } from '@/lib/use-debounced';

const columns: DataColumn<AdminAnalysisRow>[] = [
  {
    id: 'listing',
    header: 'İlan',
    primary: true,
    cell: (a) => (
      <div className="flex min-w-0 flex-col">
        <Link href={`/admin/ilanlar/${a.listingId}`} className="truncate font-medium hover:text-accent">
          {a.title}
        </Link>
        <span className="truncate text-[13px] text-muted">
          Analiz <span className="num">#{a.id}</span>, motor <span className="num">{a.engineVersion}</span>
        </span>
      </div>
    ),
  },
  { id: 'score', header: 'Skor', numeric: true, cell: (a) => <ScoreValue score={a.opportunityScore} /> },
  { id: 'confidence', header: 'Güven', cell: (a) => <ConfidenceBadge confidence={a.confidence} /> },
  {
    id: 'estimate',
    header: 'Tahmin',
    numeric: true,
    cell: (a) =>
      a.estimatedPrice ? (
        <span className="flex flex-col items-end">
          <span>{formatTl(a.estimatedPrice)}</span>
          <span className="text-[12px] text-muted">{formatDiscount(a.discountPct) ?? 'piyasa düzeyinde'}</span>
        </span>
      ) : (
        <span className="text-muted">yok</span>
      ),
  },
  { id: 'comparables', header: 'Emsal', numeric: true, cell: (a) => a.comparableCount },
  {
    id: 'event',
    header: 'Olay',
    cell: (a) =>
      a.matchEvent ? (
        <span className="text-[13px]">{MATCH_REASON_LABEL[a.matchEvent as keyof typeof MATCH_REASON_LABEL] ?? a.matchEvent}</span>
      ) : (
        <span className="text-muted">yok</span>
      ),
  },
  { id: 'createdAt', header: 'Zaman', cell: (a) => <When iso={a.createdAt} /> },
];

type Filters = Omit<AdminAnalysesQuery, 'page' | 'pageSize' | 'engineVersion'>;

export function AdminAnalysesView() {
  const [filters, setFilters] = useState<Filters>({});
  const [engineText, setEngineText] = useState('');
  const engineVersion = useDebounced(engineText.trim(), 300);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [engineVersion]);
  const query: AdminAnalysesQuery = { ...filters, ...(engineVersion ? { engineVersion } : {}), page, pageSize: ADMIN_PAGE_SIZE };
  const analyses = useAdminAnalyses(query);
  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K] | undefined) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtered = Boolean(engineVersion || filters.confidence || filters.minScore !== undefined);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="sr-only">Analizler</h1>
      <form role="search" aria-label="Analiz süzgeçleri" className="flex flex-wrap items-end gap-x-4 gap-y-3" onSubmit={(e) => e.preventDefault()}>
        <FilterSelect label="Güven" value={filters.confidence} onChange={(v) => setFilter('confidence', v as Confidence | undefined)} options={CONFIDENCE_OPTIONS} />
        <FilterSelect
          label="En düşük skor"
          value={filters.minScore !== undefined ? String(filters.minScore) : undefined}
          onChange={(v) => setFilter('minScore', v ? Number(v) : undefined)}
          options={[40, 60, 70, 80, 90].map((n) => ({ value: String(n), label: `${n} ve üzeri` }))}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="engine-version" className="text-[13px] text-muted">
            Motor sürümü
          </label>
          <Input id="engine-version" value={engineText} maxLength={50} placeholder="v1.3" onChange={(e) => setEngineText(e.target.value)} className="h-9 w-36" />
        </div>
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => {
              setFilters({});
              setEngineText('');
              setPage(1);
            }}
          >
            Süzgeçleri temizle
          </Button>
        ) : null}
      </form>
      <DataTable
        caption="Analizler"
        columns={columns}
        rowKey={(a) => a.id}
        data={analyses.data}
        isPending={analyses.isPending}
        isFetching={analyses.isFetching && !analyses.isPending}
        isError={analyses.isError}
        onRetry={() => void analyses.refetch()}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        onPageChange={setPage}
        empty={{
          icon: <Gauge className="size-5" />,
          title: filtered ? 'Bu süzgeçlere uyan analiz yok' : 'Henüz analiz yok',
          description: filtered ? 'Süzgeçleri gevşetin.' : 'İlanlar toplandıkça analiz motoru her biri için bir kayıt yazar.',
        }}
      />
    </div>
  );
}
