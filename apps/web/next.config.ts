import type { NextConfig } from 'next';

const standalone = process.env.NEXT_OUTPUT_STANDALONE !== 'false';
const apiInternalUrl = (process.env.API_INTERNAL_URL || 'http://api:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  ...(standalone ? { output: 'standalone' as const } : {}),
  experimental: { cpus: 1 },
  // Вебвью Телеграма держит страницу в кэше, и после обновления мини-приложения
  // владелец видел бы старую сборку — для /miniapp кэш запрещаем.
  async headers() {
    return [
      {
        source: '/miniapp',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
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
