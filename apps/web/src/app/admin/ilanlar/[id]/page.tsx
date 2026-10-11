import { notFound } from 'next/navigation';
import { AdminListingDetailView } from './listing-detail-view';

export default async function AdminListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!/^\d{1,10}$/.test(id) || n < 1 || n > 2_147_483_647) notFound();
  return <AdminListingDetailView id={n} />;
}
