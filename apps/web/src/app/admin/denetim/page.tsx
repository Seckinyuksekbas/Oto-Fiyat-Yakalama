import { RequireSuperAdmin } from '@/components/admin/admin-gate';
import { AuditView } from './audit-view';

/** Yalnızca SUPER_ADMIN; ADMIN kabuk içinde 404 görür (asıl yetki API'de). */
export default function AdminAuditPage() {
  return (
    <RequireSuperAdmin>
      <AuditView />
    </RequireSuperAdmin>
  );
}
