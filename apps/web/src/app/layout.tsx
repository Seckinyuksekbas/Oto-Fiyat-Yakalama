import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { GeistMono } from 'geist/font/mono';
import '@fontsource-variable/inter';
import '@fontsource-variable/instrument-sans';
import { themeColor, themeInitScript } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Oto Fırsat', template: '%s · Oto Fırsat' },
  description: 'Piyasanın altındaki ikinci el araç ilanlarını ilk siz görün.',
};

export const viewport: Viewport = {
  themeColor,
  colorScheme: 'dark light',
};

/** Async: CSP nonce'u (middleware -> `x-nonce`) okunur; bu yüzden tüm sayfalar dinamik render edilir. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="tr"
      data-theme="dark"
      suppressHydrationWarning
      className={GeistMono.variable}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
