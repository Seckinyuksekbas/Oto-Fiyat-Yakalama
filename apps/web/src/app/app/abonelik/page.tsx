import type { Metadata } from 'next';
import { SubscriptionView } from './subscription-view';

export const metadata: Metadata = { title: 'Abonelik' };

export default function SubscriptionPage() {
  return (
    <>
      <h1 className="sr-only">Abonelik</h1>
      <SubscriptionView />
    </>
  );
}
