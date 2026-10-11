import type { Metadata } from 'next';
import { AdminLayoutClient } from '@/components/admin/admin-gate';

export const metadata: Metadata = {
  title: { default: 'Yönetim', template: '%s · Yönetim · Oto Fırsat' },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}
