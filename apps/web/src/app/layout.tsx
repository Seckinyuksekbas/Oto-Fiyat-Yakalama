import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import '@fontsource-variable/inter';
import '@fontsource-variable/instrument-sans';
import { themeInitScript } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Oto Fırsat', template: '%s · Oto Fırsat' },
  description: 'Piyasanın altındaki ikinci el araç ilanlarını ilk siz görün.',
};

export const viewport: Viewport = {
  themeColor: '#0E0F11',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="tr"
      data-theme="dark"
      suppressHydrationWarning
      className={GeistMono.variable}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
