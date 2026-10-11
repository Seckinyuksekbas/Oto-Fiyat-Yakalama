import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';
import { parseWebEnv } from './src/env';

// API_ORIGIN derleme anında rewrites'a gömülür (gizli değildir). Geçersiz değerde derleme durur;
// çalışma zamanı denetimi için bkz. src/instrumentation.ts.
const { API_ORIGIN } = parseWebEnv(process.env);

// Standalone çıktı (Docker imajı). Windows'ta pnpm symlink'leri yönetici/Developer Mode ister (EPERM);
// orada yerel derleme varsayılan çıktıyı kullanır, `NEXT_STANDALONE=1` ile zorlanabilir. `NEXT_STANDALONE=0` her platformda
// kapatır (ör. E2E: `next start` ile çalıştırılan derleme).
const standalone = process.env.NEXT_STANDALONE !== '0' && (process.platform !== 'win32' || process.env.NEXT_STANDALONE === '1');

/** Monorepo kökü: `pnpm-workspace.yaml` bulunana dek yukarı çıkılır (kopyalanmış/iç içe derlemelerde de doğru kök). */
function workspaceRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (path.dirname(dir) === dir) return path.join(start, '../..');
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(standalone ? { output: 'standalone' as const } : {}),
  // Monorepo: izleme kökü repo kökü (workspace paketleri + pnpm node_modules standalone'a girsin).
  outputFileTracingRoot: workspaceRoot(__dirname),
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true }, // lint kökten (pnpm lint) çalışır
  transpilePackages: ['@oto/shared'],
  async headers() {
    return [
      {
        // CSP burada değil: istek başına nonce gerektiği için src/middleware.ts yazar. HSTS Caddy'de.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
