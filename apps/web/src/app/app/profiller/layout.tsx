import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Arama profilleri' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
