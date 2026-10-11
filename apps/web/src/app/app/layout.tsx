import { PanelWithNotifications } from '@/components/notification-bell';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return <PanelWithNotifications>{children}</PanelWithNotifications>;
}
