import { RequireSuperAdmin } from '@/components/admin/admin-gate';
import { PlansView } from './plans-view';

/** Yalnızca SUPER_ADMIN; ADMIN kabuk içinde 404 görür (asıl yetki API'de). */
export default function AdminPlansPage() {
  return (
    <RequireSuperAdmin>
      <PlansView />
    </RequireSuperAdmin>
  );
}
