import type { Metadata } from 'next';
import { AdminLayoutClient } from '@/components/admin/admin-gate';

/**
 * Sunucu metadata'sı bilerek nötrdür: rol yalnızca istemcide bilinir, USER'a giden HTML yönetim başlığı taşımamalı.
 * Yönetim sayfa başlıkları kapı geçildikten sonra `AdminShell` tarafından istemcide yazılır (`adminPageTitle`).
 * Bu yüzden `/admin/**` sayfaları `metadata.title` dışa AÇMAZ.
 */
export const metadata: Metadata = {
  title: { absolute: 'Oto Fırsat' },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}
