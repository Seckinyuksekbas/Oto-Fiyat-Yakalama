import type { Metadata } from 'next';
import { AdminOverviewView } from './overview-view';

export const metadata: Metadata = { title: 'Genel bakış' };

export default function AdminOverviewPage() {
  return <AdminOverviewView />;
}
