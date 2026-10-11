import { AppShell } from '@/components/app-shell';

// Task 8: `<AppShell bellSlot={<NotificationBell />}>` ile zil buraya bağlanır.
export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
