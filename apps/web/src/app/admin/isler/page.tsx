import { AdminJobsView } from './jobs-view';

export default async function AdminJobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = typeof sp.kaynak === 'string' ? sp.kaynak : undefined;
  const source = raw && /^\d{1,10}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 2_147_483_647 ? Number(raw) : undefined;
  return <AdminJobsView initialSource={source} />;
}
