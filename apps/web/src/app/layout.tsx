import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Inter, Instrument_Sans } from 'next/font/google';
import { themeInitScript } from '@/lib/theme';
import './globals.css';

const instrument = Instrument_Sans({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-instrument',
});
const inter = Inter({ subsets: ['latin', 'latin-ext'], display: 'swap', variable: '--font-inter' });
const geistMono = Geist_Mono({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-geist-mono',
});

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
      className={`${instrument.variable} ${inter.variable} ${geistMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
