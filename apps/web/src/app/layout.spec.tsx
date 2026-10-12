import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-geist-mono' } }));
vi.mock('@fontsource-variable/inter', () => ({}));
vi.mock('@fontsource-variable/instrument-sans', () => ({}));
vi.mock('./globals.css', () => ({}));
vi.mock('./providers', () => ({ Providers: ({ children }: { children: React.ReactNode }) => children }));
const headerStore = new Map<string, string>();
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => headerStore.get(k) ?? null }) }));

import RootLayout, { viewport } from './layout';
import { themeInitScript } from '@/lib/theme';

describe('root layout viewport', () => {
  it('declares a media-aware theme color (dark + light)', () => {
    const entries = viewport.themeColor as { media: string; color: string }[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((e) => e.media).sort()).toEqual([
      '(prefers-color-scheme: dark)',
      '(prefers-color-scheme: light)',
    ]);
    expect(entries.find((e) => e.media.includes('dark'))?.color).toBe('#0E0F11');
  });
});

describe('root layout theme script', () => {
  it('renders the theme init script with the per-request nonce from x-nonce', async () => {
    headerStore.set('x-nonce', 'dGVzdC1ub25jZQ==');
    const html = renderToStaticMarkup(await RootLayout({ children: null }));
    expect(html).toContain('<script nonce="dGVzdC1ub25jZQ==">');
    // İçerik değişmemeli: hash de CSP'de olduğu için bayt bayt aynı olmalı.
    expect(html).toContain(themeInitScript);
  });

  it('renders the theme script without a nonce attribute when x-nonce is missing', async () => {
    headerStore.clear();
    const html = renderToStaticMarkup(await RootLayout({ children: null }));
    expect(html).toContain(`<script>${themeInitScript}</script>`);
    expect(html).not.toContain('nonce=');
  });
});
