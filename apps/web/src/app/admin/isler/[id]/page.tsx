import { notFound } from 'next/navigation';
import { AdminJobDetailView } from './job-detail-view';

export default async function AdminJobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!/^\d{1,10}$/.test(id) || n < 1 || n > 2_147_483_647) notFound();
  return <AdminJobDetailView id={n} />;
}
