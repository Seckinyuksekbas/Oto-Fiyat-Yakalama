import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';
import { meHandler } from '@/test/admin-fixtures';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }), Toaster: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/isler',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AdminJobsView } from './jobs-view';
import { AdminJobDetailView } from './[id]/job-detail-view';

const job = (over: Record<string, unknown> = {}) => ({
  id: 501, sourceId: 1, sourceCode: 'demo-site', sourceName: 'Demo site', trigger: 'SCHEDULED', dryRun: false,
  status: 'PARTIAL', startedAt: '2026-10-11T09:00:00.000Z', finishedAt: '2026-10-11T09:01:30.000Z',
  pagesFetched: 5, listingsSeen: 100, listingsNew: 12, listingsUpdated: 40, listingsRemoved: 3, errorsCount: 2,
  avgResponseMs: 380, errorSummary: '2 sayfa okunamadı', createdAt: '2026-10-11T09:00:00.000Z',
  ...over,
});

describe('jobs', () => {
  it('filters the table by source, status and trigger, starting from the initial source', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      meHandler('ADMIN'),
      http.get('*/api/v1/admin/sources', () => HttpResponse.json({ total: 1, items: [{ id: 1, code: 'demo-site', name: 'Demo site' }] })),
      http.get('*/api/v1/admin/jobs', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ total: 1, items: [job()] });
      }),
    );
    const user = userEvent.setup();
    renderWithClient(<AdminJobsView initialSource={1} />);
    expect(await screen.findByRole('link', { name: 'İş #501' })).toHaveAttribute('href', '/admin/isler/501');
    expect(seen[0]!.get('source')).toBe('1');
    await user.selectOptions(screen.getByLabelText('Durum'), 'FAILED');
    await waitFor(() => expect(seen.at(-1)!.get('status')).toBe('FAILED'));
    await user.selectOptions(screen.getByLabelText('Tetikleyici'), 'MANUAL');
    await waitFor(() => expect(seen.at(-1)!.get('trigger')).toBe('MANUAL'));
  });

  it('shows job errors with masked URLs only', async () => {
    server.use(
      http.get('*/api/v1/admin/jobs/501', () =>
        HttpResponse.json({
          job: {
            ...job(),
            dryRunResult: null,
            errors: [
              { id: 1, kind: 'PARSE', url: 'https://kaynak.example/liste?…', message: 'kart başlığı yok', transient: false, createdAt: '2026-10-11T09:00:30.000Z' },
              { id: 2, kind: 'FETCH', url: null, message: 'zaman aşımı', transient: true, createdAt: '2026-10-11T09:00:40.000Z' },
            ],
          },
        }),
      ),
    );
    renderWithClient(<AdminJobDetailView id={501} />);
    expect(await screen.findByRole('heading', { level: 1, name: /İş #501/ })).toBeInTheDocument();
    expect(screen.getByText('https://kaynak.example/liste?…')).toBeInTheDocument();
    expect(screen.getByText('kart başlığı yok')).toBeInTheDocument();
    expect(screen.getByText('2 sayfa okunamadı')).toBeInTheDocument();
    // Maskeli URL tıklanabilir bağlantıya dönüştürülmez
    expect(screen.queryByRole('link', { name: /kaynak\.example/ })).toBeNull();
  });
});
