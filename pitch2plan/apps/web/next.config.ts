import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Monorepo: load the repository-root .env so `npm run dev` works from anywhere.
loadEnvConfig(new URL('../../', import.meta.url).pathname, process.env.NODE_ENV !== 'production', { info() {}, error: console.error }, true);

const isDev = process.env.NODE_ENV !== 'production';
const csp = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@pitch2plan/ai', '@pitch2plan/db', '@pitch2plan/domain', '@pitch2plan/schemas', '@pitch2plan/ui'],
  serverExternalPackages: ['pg', '@prisma/client', '@prisma/adapter-pg'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
      ],
    }];
  },
};
export default config;
