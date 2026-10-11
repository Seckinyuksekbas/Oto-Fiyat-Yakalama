import { notFound } from 'next/navigation';
import { AdminSourceDetailView } from './source-detail-view';

export default async function AdminSourceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!/^\d{1,10}$/.test(id) || n < 1 || n > 2_147_483_647) notFound();
  return <AdminSourceDetailView id={n} />;
}
