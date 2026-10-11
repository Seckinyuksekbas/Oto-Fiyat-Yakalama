import type { NextConfig } from 'next';
import { parseWebEnv } from './src/env';

// API_ORIGIN derleme anında rewrites'a gömülür (gizli değildir). Geçersiz değerde derleme durur;
// çalışma zamanı denetimi için bkz. src/instrumentation.ts.
const { API_ORIGIN } = parseWebEnv(process.env);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true }, // lint kökten (pnpm lint) çalışır
  transpilePackages: ['@oto/shared'],
  async headers() {
    return [
      {
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
