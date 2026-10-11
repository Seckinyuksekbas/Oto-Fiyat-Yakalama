import { AdminUserDetailView } from './user-detail-view';

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminUserDetailView id={id} />;
}
