#!/usr/bin/env node
// Шлюз для Telegram Mini App. Туннель (Cloudflare) смотрит сюда, а не на порт
// веба напрямую: веб проксирует /api/* на API, где большинство эндпоинтов без
// AuthGuard, поэтому выставлять 3200 в интернет нельзя. Шлюз пропускает только
// страницу /miniapp, её статику и /api/miniapp/*, всё остальное — 403.
//
// Запуск:  node scripts/miniapp-gateway.mjs
// Порт:    MINIAPP_GATEWAY_PORT (по умолчанию 3250) → цель PORT (3200).
import { createServer, request } from 'node:http';

const port = Number(process.env.MINIAPP_GATEWAY_PORT || 3250);
const targetPort = Number(process.env.PORT || 3200);
const targetHost = '127.0.0.1';

const allowed = [
  /^\/miniapp\/?(\?|$)/,
  /^\/api\/miniapp\//,
  /^\/_next\//,
  /^\/favicon\.ico$/,
];

const server = createServer((req, res) => {
  const path = req.url || '/';
  if (!allowed.some((rule) => rule.test(path))) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Доступно только мини-приложение: /miniapp\n');
    req.resume();
    return;
  }
  const upstream = request(
    { host: targetHost, port: targetPort, method: req.method, path, headers: { ...req.headers, host: `${targetHost}:${targetPort}` } },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Веб недоступен\n');
  });
  req.pipe(upstream);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`miniapp-gateway: 127.0.0.1:${port} → 127.0.0.1:${targetPort}`);
});
