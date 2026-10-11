import type { Metadata } from 'next';
import { SecurityView } from './security-view';

export const metadata: Metadata = { title: 'Güvenlik' };

export default function SecurityPage() {
  return <SecurityView />;
}
