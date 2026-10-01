#!/usr/bin/env node
/**
 * Uzum Analytics — агент мониторинга конкурентов для домашнего ПК владельца.
 * Работает БЕЗ браузера: Планировщик задач Windows (или cron) запускает его
 * раз в несколько часов, скрипт с домашнего IP снимает публичные карточки
 * конкурентов uzum.uz и шлёт на сервер аналитики (тот же протокол, что у
 * Chrome-расширения). С серверных IP каталог закрыт антиботом — поэтому
 * запуск именно с домашней сети.
 *
 * Настройка (однократно):
 *   node collect.mjs --pair 123456        # код с экрана «Конкуренты»
 * Обычный запуск (из планировщика):
 *   node collect.mjs
 * Адрес сервера: переменная UZUM_MONITOR_BASE (по умолчанию http://172.0.30.4:3200/api).
 * Токен хранится рядом в uzum-monitor-token.txt.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.UZUM_MONITOR_BASE || 'http://172.0.30.4:3200/api').replace(/\/+$/, '');
const TOKEN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'uzum-monitor-token.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

async function server(path, options = {}) {
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-watch-token': token } : {}), ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}${body?.message ? ` — ${body.message}` : ''}`);
  return body;
}

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};
const pick = (obj, keys) => { for (const key of keys) { const v = obj?.[key]; if (v !== undefined && v !== null) return v; } return null; };

function parseProduct(productId, body) {
  const data = body?.payload?.data ?? body?.payload ?? body?.data?.payload ?? body?.data ?? body;
  if (!data || typeof data !== 'object') return null;
  const skus = Array.isArray(data.skuList) ? data.skuList : Array.isArray(data.skus) ? data.skus : [];
  let price = null; let available = 0; let availableKnown = false;
  for (const sku of skus) {
    const skuPrice = num(pick(sku, ['purchasePrice', 'purchase_price', 'sellPrice', 'sell_price', 'price']));
    const skuAvail = num(pick(sku, ['availableAmount', 'available_amount', 'restAmount', 'rest_amount', 'amount']));
    if (skuAvail !== null) { availableKnown = true; available += Math.max(0, skuAvail); }
    const sellable = skuAvail === null || skuAvail > 0;
    if (skuPrice !== null && sellable && (price === null || skuPrice < price)) price = skuPrice;
  }
  if (price === null) price = num(pick(data, ['price', 'minSellPrice', 'min_sell_price']));
  if (price === null) return null;
  return {
    productId: String(productId),
    title: String(pick(data, ['title', 'localizableTitle']) || '').slice(0, 300) || null,
    price,
    fullPrice: num(pick(data, ['fullPrice', 'full_price', 'oldPrice', 'old_price'])),
    available: availableKnown ? available : null,
    ordersAmount: num(pick(data, ['ordersAmount', 'orders_amount', 'ordersQuantity', 'orders_quantity'])),
    rating: num(pick(data, ['rating', 'ratingValue'])),
    reviewsCount: num(pick(data, ['reviewsAmount', 'reviews_amount', 'reviewsCount', 'feedbackQuantity'])),
  };
}

async function fetchProduct(productId) {
  const res = await fetch(`https://api.uzum.uz/api/v2/product/${encodeURIComponent(productId)}`, {
    headers: { Accept: 'application/json', 'Accept-Language': 'ru-RU', 'User-Agent': UA },
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`карточка ${productId}: редирект ${res.status} (похоже на капчу — IP не подходит)`);
  if (!res.ok) throw new Error(`карточка ${productId}: HTTP ${res.status}`);
  return parseProduct(productId, await res.json());
}

async function fetchPositions(query, ownProductIds) {
  const res = await fetch(`https://uzum.uz/ru/search?query=${encodeURIComponent(query)}`, {
    headers: { Accept: 'text/html', 'Accept-Language': 'ru-RU', 'User-Agent': UA }, redirect: 'manual',
  });
  if (!res.ok) return [];
  const html = await res.text();
  const seen = []; const seenSet = new Set();
  for (const match of html.matchAll(/\/product\/(?:[^"'\s/]*-)?(\d{4,})/g)) {
    if (!seenSet.has(match[1])) { seenSet.add(match[1]); seen.push(match[1]); }
    if (seen.length >= 100) break;
  }
  const totalMatch = html.match(/"total"\s*:\s*(\d+)/);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  const own = new Set(ownProductIds);
  return seen.map((id, index) => ({ id, position: index + 1 }))
    .filter((row) => own.has(row.id))
    .map((row) => ({ query, productExternalId: row.id, position: row.position, page: Math.ceil(row.position / 24), totalResults: total }));
}

async function main() {
  const pairIndex = process.argv.indexOf('--pair');
  if (pairIndex !== -1) {
    const code = process.argv[pairIndex + 1];
    const result = await server('/competitor-watch/pair', { method: 'POST', body: JSON.stringify({ code }) });
    writeFileSync(TOKEN_FILE, result.token, 'utf8');
    console.log('Подключено. Токен сохранён в', TOKEN_FILE);
    return;
  }
  if (!existsSync(TOKEN_FILE)) { console.error('Нет токена. Возьмите код на экране «Конкуренты» и выполните: node collect.mjs --pair 123456'); process.exit(1); }
  const targets = await server('/competitor-watch/targets');
  const products = []; const errors = [];
  for (const productId of (targets.products || []).slice(0, 50)) {
    try {
      const row = await fetchProduct(productId);
      if (row) products.push(row); else errors.push(`карточка ${productId}: не распознан формат ответа`);
    } catch (error) { errors.push(String(error?.message || error)); }
    await sleep(jitter(1500, 3000));
  }
  const positions = [];
  for (const query of (targets.positionQueries || []).slice(0, 30)) {
    try { positions.push(...await fetchPositions(query, targets.ownProductIds || [])); }
    catch { /* позиции необязательны */ }
    await sleep(jitter(1500, 3000));
  }
  const result = await server('/competitor-watch/ingest', { method: 'POST', body: JSON.stringify({ products, positions }) });
  console.log(`Готово: карточек ${products.length}, позиций ${positions.length}, алертов ${result.alerts ?? 0}${errors.length ? `; ошибок ${errors.length}: ${errors[0]}` : ''}`);
  if (errors.length && products.length === 0) process.exit(1);
}

main().catch((error) => { console.error('Сбой:', error?.message || error); process.exit(1); });
