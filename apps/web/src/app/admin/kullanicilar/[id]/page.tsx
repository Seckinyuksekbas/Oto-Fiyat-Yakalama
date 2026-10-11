import type { Metadata } from 'next';
import { AdminUserDetailView } from './user-detail-view';

export const metadata: Metadata = { title: 'Kullanıcı detayı' };

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminUserDetailView id={id} />;
}
