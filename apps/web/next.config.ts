import type { NextConfig } from 'next';

const standalone = process.env.NEXT_OUTPUT_STANDALONE !== 'false';
// Адрес API для rewrites. Значение попадает в сборку (output: standalone читает
// конфиг на этапе build), поэтому собирать веб нужно с загруженным .env —
// иначе мини-приложение и дашборд получают 502 на каждый /api/*. Запасной адрес
// локальный: docker-сборка задаёт API_INTERNAL_URL=http://api:4000 сама.
const apiInternalUrl = (process.env.API_INTERNAL_URL || `http://127.0.0.1:${process.env.API_PORT || 4100}`).replace(/\/$/, '');
if (!process.env.API_INTERNAL_URL) console.warn(`[next.config] API_INTERNAL_URL не задан, использую ${apiInternalUrl}`);

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
