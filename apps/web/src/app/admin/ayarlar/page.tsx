import { RequireSuperAdmin } from '@/components/admin/admin-gate';
import { SettingsView } from './settings-view';

/** Yalnızca SUPER_ADMIN; ADMIN kabuk içinde 404 görür (asıl yetki API'de). */
export default function AdminSettingsPage() {
  return (
    <RequireSuperAdmin>
      <SettingsView />
    </RequireSuperAdmin>
  );
}
