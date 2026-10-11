import { z } from 'zod';

// src/env.ts ile aynı kural (next.config.mjs .ts dosyası içe aktaramaz). Geçersiz değerde derleme/başlatma durur.
const apiOriginResult = z
  .string()
  .url()
  .refine((v) => URL.canParse(v) && ['http:', 'https:'].includes(new URL(v).protocol), 'http(s) adresi olmalı')
  .transform((v) => v.replace(/\/+$/, ''))
  .default('http://localhost:3001')
  .safeParse(process.env.API_ORIGIN);
if (!apiOriginResult.success) {
  throw new Error(`Invalid environment: API_ORIGIN: ${apiOriginResult.error.issues.map((i) => i.message).join('; ')}`);
}
const API_ORIGIN = apiOriginResult.data;

/** @type {import('next').NextConfig} */
const nextConfig = {
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
