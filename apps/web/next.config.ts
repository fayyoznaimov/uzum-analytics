import type { NextConfig } from 'next';

const standalone = process.env.NEXT_OUTPUT_STANDALONE !== 'false';
const apiInternalUrl = (process.env.API_INTERNAL_URL || 'http://api:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  ...(standalone ? { output: 'standalone' as const } : {}),
  experimental: { cpus: 1 },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiInternalUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
