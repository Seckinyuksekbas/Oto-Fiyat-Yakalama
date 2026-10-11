import type { Metadata } from 'next';
import { AdminUsersView } from './users-view';

export const metadata: Metadata = { title: 'Kullanıcılar' };

export default function AdminUsersPage() {
  return <AdminUsersView />;
}
