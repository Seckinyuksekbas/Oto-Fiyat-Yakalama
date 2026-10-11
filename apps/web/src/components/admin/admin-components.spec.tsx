import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';
import { DataTable, type DataColumn } from './data-table';
import { KpiTile } from './kpi-tile';
import { StatusBadge } from './status-badge';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

interface Row {
  id: number;
  name: string;
  n: number;
}
const columns: DataColumn<Row>[] = [
  { id: 'name', header: 'Ad', cell: (r) => r.name, sortable: true, primary: true },
  { id: 'n', header: 'Adet', cell: (r) => r.n, numeric: true, sortable: true },
];
const rows: Row[] = [
  { id: 1, name: 'Bir', n: 10 },
  { id: 2, name: 'İki', n: 20 },
];

function setWide(wide: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({ matches: wide, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList,
  );
}
afterEach(() => vi.restoreAllMocks());

describe('DataTable', () => {
  it('renders a table on wide screens with sortable headers and pagination', async () => {
    setWide(true);
    const onPage = vi.fn();
    const onSort = vi.fn();
    render(
      <DataTable
        caption="Deneme"
        columns={columns}
        rowKey={(r) => r.id}
        data={{ items: rows, total: 45 }}
        page={1}
        pageSize={20}
        onPageChange={onPage}
        sort={{ id: 'n', dir: 'desc' }}
        onSortChange={onSort}
      />,
    );
    const table = screen.getByRole('table', { name: 'Deneme' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('columnheader', { name: /Adet/ })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(within(table).getByRole('button', { name: /^Ad(\s|,|$)/ }));
    expect(onSort).toHaveBeenCalledWith({ id: 'name', dir: 'asc' });
    await userEvent.click(within(table).getByRole('button', { name: /Adet/ }));
    expect(onSort).toHaveBeenLastCalledWith({ id: 'n', dir: 'asc' });
    expect(screen.getByText(/1–20/)).toBeInTheDocument();
    expect(screen.getByText(/45/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Önceki sayfa' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it('renders a card list at ≤768px', () => {
    setWide(false);
    render(
      <DataTable caption="Deneme" columns={columns} rowKey={(r) => r.id} data={{ items: rows, total: 2 }} page={1} pageSize={20} onPageChange={vi.fn()} />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Deneme' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[1]!).getByText('Adet')).toBeInTheDocument();
    expect(within(items[1]!).getByText('20')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sonraki sayfa' })).not.toBeInTheDocument();
  });

  it('shows loading, empty and error states', async () => {
    setWide(true);
    const retry = vi.fn();
    const { rerender } = render(
      <DataTable caption="D" columns={columns} rowKey={(r) => r.id} isPending page={1} pageSize={20} onPageChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('D yükleniyor')).toHaveAttribute('aria-busy', 'true');
    rerender(
      <DataTable caption="D" columns={columns} rowKey={(r) => r.id} data={{ items: [], total: 0 }} page={1} pageSize={20} onPageChange={vi.fn()} empty={{ title: 'Kayıt yok' }} />,
    );
    expect(screen.getByText('Kayıt yok')).toBeInTheDocument();
    rerender(
      <DataTable caption="D" columns={columns} rowKey={(r) => r.id} isError errorTitle="D yüklenemedi" onRetry={retry} page={1} pageSize={20} onPageChange={vi.fn()} />,
    );
    expect(screen.getByText('D yüklenemedi')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(retry).toHaveBeenCalled();
  });

  it('keeps rows and shows an inline error with retry when a refetch fails while data is shown', async () => {
    setWide(true);
    const retry = vi.fn();
    render(
      <DataTable caption="D" columns={columns} rowKey={(r) => r.id} data={{ items: rows, total: 2 }} isError onRetry={retry} page={1} pageSize={20} onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole('table', { name: 'D' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Bu sayfa yüklenemedi');
    await userEvent.click(within(alert).getByRole('button', { name: 'Yeniden dene' }));
    expect(retry).toHaveBeenCalled();
  });

  it('supports row selection with a select-all checkbox', async () => {
    setWide(true);
    function Harness() {
      const [sel, setSel] = useState<Set<number>>(new Set());
      return (
        <>
          <DataTable
            caption="Seçim"
            columns={columns}
            rowKey={(r) => r.id}
            data={{ items: rows, total: 2 }}
            page={1}
            pageSize={20}
            onPageChange={vi.fn()}
            selection={{ selected: sel, onChange: setSel, rowLabel: (r) => r.name, isSelectable: (r) => r.id !== 2 }}
          />
          <output>{[...sel].join(',')}</output>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('checkbox', { name: 'İki seç' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sayfadakilerin tümünü seç' }));
    expect(screen.getByRole('status')).toHaveTextContent('1');
  });
});

describe('KpiTile', () => {
  it('formats numbers in Turkish and renders "—" with a hint for null', () => {
    render(
      <>
        <KpiTile label="Aktif ilan" value={48210} />
        <KpiTile label="Kuyruk" value={null} unavailableHint="Redis'e ulaşılamıyor" />
      </>,
    );
    expect(screen.getByRole('group', { name: 'Aktif ilan' })).toHaveTextContent('48.210');
    const q = screen.getByRole('group', { name: 'Kuyruk' });
    expect(q).toHaveTextContent('—');
    expect(q).toHaveTextContent("Redis'e ulaşılamıyor");
  });
});

describe('StatusBadge', () => {
  it('maps known statuses to Turkish labels and falls back to the raw value', () => {
    render(
      <>
        <StatusBadge status="SUSPENDED" />
        <StatusBadge status="DOWN" />
        <StatusBadge status="WHATEVER" />
      </>,
    );
    expect(screen.getByText('Askıda')).toBeInTheDocument();
    expect(screen.getByText('Çalışmıyor')).toBeInTheDocument();
    expect(screen.getByText('WHATEVER')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('requires typed confirmation and shows the mapped error when onConfirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('net'));
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Silinsin mi?"
        description="Geri alınamaz."
        confirmLabel="Sil"
        tone="danger"
        confirmText="SIL"
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Silinsin mi?' });
    const btn = within(dialog).getByRole('button', { name: 'Sil' });
    expect(btn).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'SIL');
    await userEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Bağlantı hatası/);
  });

  it('closes on success', async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} title="Emin misiniz?" confirmLabel="Evet" onConfirm={() => Promise.resolve()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Evet' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
