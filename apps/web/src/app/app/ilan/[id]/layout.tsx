import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'İlan detayı' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
