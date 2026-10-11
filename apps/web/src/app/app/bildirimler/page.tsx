import type { Metadata } from 'next';
import { NotificationsView } from './notifications-view';

export const metadata: Metadata = { title: 'Bildirimler' };

export default function NotificationsPage() {
  return (
    <>
      <h1 className="sr-only">Bildirimler</h1>
      <NotificationsView />
    </>
  );
}
