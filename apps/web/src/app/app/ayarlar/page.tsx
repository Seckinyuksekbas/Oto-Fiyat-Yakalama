import type { Metadata } from 'next';
import { AccountView } from './account-view';

export const metadata: Metadata = { title: 'Hesap ayarları' };

export default function AccountPage() {
  return <AccountView />;
}
