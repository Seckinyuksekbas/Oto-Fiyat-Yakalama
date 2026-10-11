import { Suspense } from 'react';
import { PanelWithNotifications } from '@/components/notification-bell';
import { RetryFlagStripper } from '@/lib/session';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <PanelWithNotifications>
      <Suspense fallback={null}>
        <RetryFlagStripper />
      </Suspense>
      {children}
    </PanelWithNotifications>
  );
}
