import type { Metadata } from 'next';
import { SubscriptionView } from './subscription-view';

export const metadata: Metadata = { title: 'Abonelik' };

export default function SubscriptionPage() {
  return <SubscriptionView />;
}
